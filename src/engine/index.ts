// --- EngineManager: venv resolution, spawn, queue, snapshots, abort grace, teardown; the wire lives in kernel.ts ---

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveHelperDirs } from "./helpers-locate.js";
import { type HelperLoadResult, KernelClient } from "./kernel.js";
import { formatPythonFailure, type PythonResolution, type PythonSource, resolvePython } from "./python-locate.js";

export type { HelperLoadResult } from "./kernel.js";
export { formatPythonFailure, managedVenvDir, pythonCandidates, resolvePython } from "./python-locate.js";

/** A wedged guest never answers the shutdown snapshot; this is what keeps session_shutdown from hanging. */
const SHUTDOWN_SNAPSHOT_DEADLINE_MS = Number(process.env.PI_REPL_SNAPSHOT_DEADLINE_MS ?? 15_000) || 15_000;

/** Stop waiting after the deadline; the underlying op is still settled by the kill that follows. */
function withDeadline<T>(promise: Promise<T | null>, ms: number): Promise<T | null> {
	return new Promise<T | null>((resolve) => {
		const timer = setTimeout(() => resolve(null), ms);
		timer.unref?.();
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value ?? null);
			},
			() => {
				clearTimeout(timer);
				resolve(null);
			},
		);
	});
}

export const DEFAULT_MAX_OUTPUT_CHARS = 46080;
/** A configured cap this small produces output nobody can read; such a value is ignored, not honoured. */
const MIN_USEFUL_OUTPUT_CHARS = 512;
/** Per-line cap: one giant line must not own the channel budget while long JSON/reprs/errors still pass whole. */
export const MAX_OUTPUT_LINE_CHARS = 4096;
/**
 * How long an aborted cell gets to observe the interrupt before the kernel is killed.
 *
 * Measured on Windows: an interrupt takes effect at the cell's next Python bytecode boundary, never inside a
 * blocking call — a loop of 0.05 s sleeps is cut ~0.2 s after the signal, while a single time.sleep(3) runs the
 * whole 3 s and only then raises KeyboardInterrupt. A cell parked in one long C call (a hung DraftSight RPC, a
 * socket read, a native compute) never observes it at all, and only the kill reaches it.
 *
 * So the grace costs nothing when it works (milliseconds) and buys nothing when it does not. The old 20 s was a
 * guess; 5 s reaps a wedged kernel promptly while still letting a yielding cell unwind its finally blocks.
 */
const DEFAULT_ABORT_GRACE_MS = 5_000;
/** Shared deadline: bounds a wedged boot (lifecycle) and a wedged background restore alike. */
export const DEFAULT_BOOT_TIMEOUT_MS = 90_000;
/** Snapshot size cap, also per-entry; oversized bindings are reported as skipped names. */
const DEFAULT_SNAPSHOT_MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_SNAPSHOT_PERIOD_MS = 120_000;

interface EngineExecuteError {
	name: string;
	message: string;
	stack: string[];
}

export interface ExecuteResult {
	stdout: string;
	stderr: string;
	result?: string;
	status: "ok" | "error" | "aborted";
	error?: EngineExecuteError;
	durationMs: number;
}

export interface ExecuteOptions {
	/** Aborting cancels the cell via kernel interrupt; the namespace is preserved. */
	signal?: AbortSignal;
	onStream?: (chunk: string, name: "stdout" | "stderr") => void;
	maxOutputChars?: number;
}

export interface SnapshotResult {
	path: string;
	saved: string[];
	/** Names that could not be serialized, with reasons. */
	failed: { name: string; reason: string }[];
}

export interface RestoreResult {
	path: string;
	restored: string[];
	failed: { name: string; reason: string }[];
}

export interface EngineOptions {
	cwd?: string;
	env?: Record<string, string>;
	snapshot?: {
		path: string;
		/** Total base64 payload cap; also the per-entry cap. Oversized entries are skipped with a reason. Default 128 MiB. */
		maxBytes?: number;
		/** Force a refresh when the last persisted snapshot is older than this, even if no name changed. 0 disables. Default 2 min. */
		periodMs?: number;
	};
	/** Do not revive the snapshot on this engine (used after a wedged restore was detected once). */
	skipRestore?: boolean;
	/** True when this engine's snapshot was inherited from a /fork'd parent session. */
	forkInherited?: boolean;
}

// --- process-wide cleanup: a child does not die with its parent, so SIGKILL live kernels on exit ---

const liveEngines = new Set<EngineManager>();
let cleanupHandlersInstalled = false;

function installProcessCleanupOnce(): void {
	if (cleanupHandlersInstalled) return;
	cleanupHandlersInstalled = true;
	process.on("exit", () => {
		for (const engine of liveEngines) engine.killSync();
	});
}

function truncateWithMarker(text: string, maxChars: number, wasTruncated: boolean): string {
	if (!wasTruncated && text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n[... output truncated at ${maxChars} chars ...]`;
}

export function capLinesForContext(text: string): { text: string; trimmed: boolean } {
	const lines = text.split("\n");
	let trimmed = false;
	const mapped = lines.map((line) => {
		if (line.length <= MAX_OUTPUT_LINE_CHARS) return line;
		trimmed = true;
		return line.slice(0, MAX_OUTPUT_LINE_CHARS);
	});
	return { text: mapped.join("\n"), trimmed };
}

const DEFAULT_KEEP_SNAPSHOTS = 25;

/** Keep the newest `keep` snapshot dirs; the live dir is exempt and manifest-less dirs are ignored. */
export function pruneSnapshotDirs(stateRoot: string, keep: number = DEFAULT_KEEP_SNAPSHOTS, currentDir?: string): void {
	const entries: { dir: string; mtimeMs: number }[] = [];
	try {
		for (const name of readdirSync(stateRoot, { withFileTypes: true })) {
			if (!name.isDirectory() || name.name === currentDir) continue;
			try {
				const manifest = join(stateRoot, name.name, "namespace.snapshot");
				if (!existsSync(manifest)) continue;
				entries.push({ dir: join(stateRoot, name.name), mtimeMs: statSync(manifest).mtimeMs });
			} catch {}
		}
	} catch {
		return;
	}
	entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
	for (const { dir } of entries.slice(keep)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {}
	}
}

// --- orphan sweep: a state dir whose conversation file exists in no project root dies with it; only manifest dirs are touched, live + ephemeral exempt ---
export function pruneOrphanedSnapshotDirs(
	stateRoot: string,
	sessionsRoot: string | undefined,
	currentDir?: string,
): number {
	if (!sessionsRoot || !existsSync(sessionsRoot)) return 0;
	const liveNames = new Set<string>();
	try {
		for (const proj of readdirSync(sessionsRoot, { withFileTypes: true })) {
			if (!proj.isDirectory()) continue;
			for (const f of readdirSync(join(sessionsRoot, proj.name))) {
				if (!f.endsWith(".jsonl")) continue;
				const name = f.slice(0, -".jsonl".length);
				// --- both dir formats (legacy bare-name and slug-keyed) are live while their conversation lives ---
				liveNames.add(name);
				liveNames.add(`${proj.name}__${name}`);
			}
		}
	} catch {
		return 0;
	}
	let removed = 0;
	try {
		for (const entry of readdirSync(stateRoot, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name === currentDir || entry.name === "ephemeral") continue;
			if (liveNames.has(entry.name)) continue;
			if (!existsSync(join(stateRoot, entry.name, "namespace.snapshot"))) continue;
			rmSync(join(stateRoot, entry.name), { recursive: true, force: true });
			removed++;
		}
	} catch {
		// readdir can race a concurrent sweep; give up quietly rather than partial-delete
	}
	return removed;
}

export class EngineManager {
	private readonly options: EngineOptions;
	private kernel?: KernelClient;
	private state: "idle" | "starting" | "running" | "shutdown" = "idle";
	private startPromise?: Promise<void>;
	private executionQueue: Promise<unknown> = Promise.resolve();
	private python?: PythonResolution;
	private restoredKernel?: KernelClient;
	/** A wedged revive marks the engine: later kernels boot without restoring. */
	private restoreSkipped: boolean;
	private restoreResolve?: (result: RestoreResult | null) => void;
	private restorePromise?: Promise<RestoreResult | null>;
	private restoreSettledResult?: RestoreResult | null;
	private helperReport: readonly HelperLoadResult[] | null = null;
	/** Whether the current boot's report has been handed out (once per boot). */
	private helperReportTaken = true;
	private readonly forkInherited: boolean;
	/** Per-engine, because the right grace depends on what the cell is doing (see DEFAULT_ABORT_GRACE_MS). */
	private readonly abortGraceMs: number;
	/**
	 * Output cap applied when a caller does not name one. Env-overridable because the right number depends on who
	 * is reading: a model browsing a REPL wants everything, while a caller with its own shared output budget
	 * spread across many results wants one cell not to spend it all.
	 */
	private readonly maxOutputCharsDefault: number;
	/**
	 * Set when an abort's grace expired and the kernel had to be killed. The next cell then boots a fresh kernel
	 * and revives the snapshot ahead of it; without the flag the engine would sit at `shutdown` and every later
	 * cell would throw, ending the session's Python over one wedged RPC.
	 */
	private reapRecovery = false;

	constructor(options: EngineOptions = {}) {
		this.options = options;
		this.abortGraceMs = Math.max(
			0,
			Number(process.env.PI_REPL_ABORT_GRACE_MS ?? options.env?.PI_REPL_ABORT_GRACE_MS ?? DEFAULT_ABORT_GRACE_MS),
		);
		const configuredCap = Number(process.env.PI_REPL_MAX_OUTPUT_CHARS ?? options.env?.PI_REPL_MAX_OUTPUT_CHARS);
		this.maxOutputCharsDefault =
			Number.isInteger(configuredCap) && configuredCap >= MIN_USEFUL_OUTPUT_CHARS
				? configuredCap
				: DEFAULT_MAX_OUTPUT_CHARS;
		this.forkInherited = options.forkInherited ?? false;
		this.restoreSkipped = options.skipRestore ?? false;
		// no snapshot capability: recovery is trivially "nothing to revive"
		if (!options.snapshot) this.settleRestore(null);
	}

	get isRunning(): boolean {
		return this.state === "running" && (this.kernel?.isRunning ?? false);
	}

	/** The cap a cell gets when the caller named none; public so the rule can be tested without a kernel. */
	get outputCharBudget(): number {
		return this.maxOutputCharsDefault;
	}

	/** Spawned pid (the venv launcher on Windows). See KernelClient for the three-role explanation. */
	get pid(): number | undefined {
		return this.kernel?.pid;
	}

	/** The bridge process (op stream + ZMQ channels). */
	get bridgePid(): number | undefined {
		return this.kernel?.bridgePid;
	}

	/** The ipykernel subprocess pid — the one a leaked COM handle belongs to. */
	get kernelPid(): number | undefined {
		return this.kernel?.kernelPid;
	}

	/** Boot state as a value (a field read is not narrowed away by control flow). */
	get bootState(): "idle" | "starting" | "running" | "shutdown" {
		return this.state;
	}

	/** Where this conversation's namespace lives on disk; undefined for an ephemeral session. */
	get snapshotPath(): string | undefined {
		return this.options.snapshot?.path;
	}

	/** True when this engine is a fork that inherited its parent's namespace (drives the fork toast). */
	get inheritedFromFork(): boolean {
		return this.forkInherited;
	}

	/** Interpreter the kernel runs on, as resolved at boot; undefined before the first boot. */
	get pythonInterpreter(): string | undefined {
		return this.python?.executable ?? this.python?.argv[0];
	}

	/** Which rule selected that interpreter (pin, project venv, managed venv, PATH). */
	get pythonSource(): PythonSource | undefined {
		return this.python?.source;
	}

	/** Current boot's helper verdicts, handed out once per boot (first cell of a session/rebuild); null when nothing to announce. */
	takeHelperReport(): readonly HelperLoadResult[] | null {
		if (this.helperReportTaken) return null;
		this.helperReportTaken = true;
		return this.helperReport;
	}

	// --- state can flip to shutdown at any time; read it via a method so TS can't narrow the union away ---
	private isShutdown(): boolean {
		return this.state === "shutdown";
	}

	async start(): Promise<void> {
		if (this.state === "shutdown") throw new Error("Engine has been shut down");
		if (!this.startPromise) {
			const startup = this.doStart().catch((error) => {
				this.startPromise = undefined;
				throw error;
			});
			// --- keep a startup failure nobody awaits from surfacing as unhandled ---
			startup.catch(() => {});
			this.startPromise = startup;
		}
		return this.startPromise;
	}

	private async doStart(): Promise<void> {
		this.state = "starting";
		// --- one interpreter answer for the whole machine (see python-locate.ts): a pin wins outright,
		// --- everything else has to prove it can import the bridge's deps before it is trusted ---
		const resolved = resolvePython(this.options.cwd, { helperDirs: resolveHelperDirs(this.options.cwd) });
		this.python = resolved;
		if (!resolved.ok) {
			this.state = "idle";
			throw new Error(formatPythonFailure(resolved));
		}
		installProcessCleanupOnce();
		liveEngines.add(this);
		const timeoutMs = Number(process.env.PI_REPL_TIMEOUT_MS ?? this.options.env?.PI_REPL_TIMEOUT_MS ?? 0) || 0;
		try {
			const snap = this.options.snapshot;
			this.kernel = await KernelClient.start(resolved.argv, {
				cwd: this.options.cwd,
				// --- PI_PYTHON is the contract with sibling skills: draftsight-com installs its package
				// --- into $PI_PYTHON, so the package lands in the interpreter that actually runs cells ---
				env: { ...this.options.env, ...(resolved.executable ? { PI_PYTHON: resolved.executable } : {}) },
				timeoutMs,
				snapshot: snap
					? {
							path: snap.path,
							max_bytes: snap.maxBytes ?? DEFAULT_SNAPSHOT_MAX_BYTES,
							period_ms: snap.periodMs ?? DEFAULT_SNAPSHOT_PERIOD_MS,
						}
					: undefined,
			});
			// --- a fresh boot's helper verdicts are announced once, on the first cell after it ---
			this.helperReport = this.kernel.helperReport;
			this.helperReportTaken = false;
			// --- drop a dead kernel so the next execute rebuilds; never resume a zombie ---
			const current = this.kernel;
			current.setOnUnexpectedExit(() => {
				if (this.kernel !== current) return;
				this.kernel = undefined;
				this.startPromise = undefined;
				this.helperReport = null;
			});
		} catch (error) {
			if (this.state === "starting") this.state = "idle";
			liveEngines.delete(this);
			throw error;
		}
		// --- win the shutdown race: don't resurrect a killed engine as running ---
		if (this.isShutdown()) {
			this.kernel?.kill();
			this.kernel = undefined;
			throw new Error("Engine has been shut down");
		}
		this.state = "running";
		// --- recovery runs in the bridge's first quiet gap — never ahead of a user cell ---
		this.restoreInBackground();
	}

	/** Abrupt teardown: SIGKILL the kernel; safe from process.on("exit"). */
	killSync(): void {
		this.state = "shutdown";
		liveEngines.delete(this);
		this.kernel?.kill();
		this.kernel = undefined;
	}

	async kill(): Promise<void> {
		this.killSync();
	}

	async dispose(): Promise<void> {
		if (this.state === "running") {
			// --- interrupt first: the bridge serialises ops, so a snapshot queues behind the running cell
			// --- and the deadline below would be spent waiting out a cell that is about to be killed anyway ---
			if (this.kernel?.hasActiveCell) this.kernel.requestInterrupt();
			// --- bounded: an unanswered snapshot op would keep session_shutdown from returning, and the
			// --- process group would stay alive holding every handle the kernel had open ---
			await withDeadline(
				this.snapshotState().catch(() => null),
				SHUTDOWN_SNAPSHOT_DEADLINE_MS,
			);
		}
		await this.kernel?.shutdown();
		this.killSync();
	}

	async execute(code: string, opts: ExecuteOptions = {}): Promise<ExecuteResult> {
		// --- claim the queue slot synchronously so order == submission order ---
		const previous = this.executionQueue;
		let release: () => void = () => {};
		this.executionQueue = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;

		try {
			if (opts.signal?.aborted) {
				return { stdout: "", stderr: "", status: "aborted", durationMs: 0 };
			}
			if (this.isShutdown()) {
				throw new Error("Engine has been shut down");
			}
			// --- the abort can land while a cold engine is still booting, and it used to be lost: the listener was
			// --- attached only once the cell had been submitted, so an abort during boot changed nothing and the cell
			// --- then ran to completion (measured: a sleep(20) withdrawn at +0.8 s ran the full 20 s). ---
			const started = Date.now();
			let withdrawn = false;
			let aborted = false;
			let graceTimer: ReturnType<typeof setTimeout> | undefined;
			// --- the grace expiring means the cell never reached a Python boundary: the kernel was reaped, and every
			// --- live handle it held (COM proxy, open file, connection) died with it. The model has to be told,
			// --- because "aborted" alone implies the namespace is intact. ---
			let reapedDuringAbort = false;
			const onAbort = () => {
				withdrawn = true;
				aborted = true;
				this.kernel?.requestInterrupt();
				// --- interrupt is a real KeyboardInterrupt, but a C-wedged cell ignores it; then kill and rebuild ---
				graceTimer = setTimeout(() => {
					if (this.state === "running" && this.kernel) {
						reapedDuringAbort = true;
						// --- the engine survives its kernel: idle, not shutdown, so the next cell gets a fresh one and
						// --- a snapshot revive instead of an "Engine has been shut down" for the rest of the session ---
						this.state = "idle";
						this.reapRecovery = true;
						this.kernel.kill();
						this.kernel = undefined;
						this.startPromise = undefined;
						this.helperReport = null;
					}
				}, this.abortGraceMs);
				graceTimer.unref?.();
			};
			if (opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true });
			await this.start();
			// --- reaped by a previous cell's expired grace: rebuild before this one runs, snapshot first ---
			if (this.reapRecovery) {
				this.reapRecovery = false;
				await this.start();
				await this.restoreWithReap().catch(() => null);
				if (!this.isRunning) {
					this.kernel = undefined;
					this.startPromise = undefined;
					await this.start();
				}
			}
			// --- the kernel may have died after boot resolved but before its exit event; drop the zombie and rebuild ---
			if (this.kernel && !this.kernel.isRunning) {
				this.kernel = undefined;
				this.startPromise = undefined;
				await this.start();
				// --- a mid-session rebuild revives the snapshot BEFORE the triggering cell (startup recovery is background); a wedged revive kills the kernel and the retry skips the restore ---
				await this.restoreWithReap().catch(() => null);
				// --- read health via the getter: TS narrowed this.kernel away, but start() may have replaced it ---
				if (!this.isRunning) {
					this.kernel = undefined;
					this.startPromise = undefined;
					await this.start();
				}
			}
			if (this.isShutdown()) {
				throw new Error("Engine has been shut down");
			}
			// --- withdrawn during the boot: the cell was never submitted, so there is nothing to interrupt. The
			// --- engine stays warm and the next cell is served normally. ---
			if (withdrawn) {
				return { stdout: "", stderr: "", status: "aborted", durationMs: Date.now() - started };
			}

			const maxChars = opts.maxOutputChars ?? this.maxOutputCharsDefault;

			try {
				const r = await this.kernel!.executeCell(code, {
					signal: opts.signal,
					onStream: opts.onStream,
					maxOutputChars: maxChars,
				});
				const status: ExecuteResult["status"] = opts.signal?.aborted ? "aborted" : r.status;
				// Channel cap (truncateWithMarker), then per-line cap; both append a marker so truncation is explicit.
				const finalize = (text: string, channelTruncated: boolean): string => {
					let out = truncateWithMarker(text, maxChars, channelTruncated);
					const line = capLinesForContext(out);
					if (line.trimmed) out = `${line.text}\n[... some lines exceeded ${MAX_OUTPUT_LINE_CHARS} chars ...]`;
					else out = line.text;
					return out;
				};
				const reapedError: EngineExecuteError | undefined = reapedDuringAbort
					? {
							name: "KernelReaped",
							message:
								`the cell ignored the interrupt for ${this.abortGraceMs / 1000}s — it was parked inside a C call, which no interrupt can cut — so the kernel was killed. ` +
								"Every live object the cell held (COM proxy, open file, database connection) died with it; any namespace recovery comes from the last snapshot, not from memory.",
							stack: [],
						}
					: undefined;
				return {
					stdout: finalize(r.stdout, r.truncated?.stdout ?? false),
					stderr: finalize(r.stderr, r.truncated?.stderr ?? false),
					result: r.result !== undefined ? finalize(String(r.result), String(r.result).length > maxChars) : undefined,
					error: reapedError ?? r.error,
					status,
					durationMs: Date.now() - started,
				};
			} catch (error) {
				if (aborted) {
					return {
						stdout: "",
						stderr: "",
						status: "aborted",
						durationMs: Date.now() - started,
						...(reapedDuringAbort
							? {
									error: {
										name: "KernelReaped",
										message:
											`the cell ignored the interrupt for ${this.abortGraceMs / 1000}s — it was parked inside a C call, which no interrupt can cut — so the kernel was killed. ` +
											"Every live object the cell held (COM proxy, open file, database connection) died with it.",
										stack: [],
									} satisfies EngineExecuteError,
								}
							: {}),
					};
				}
				throw error;
			} finally {
				opts.signal?.removeEventListener("abort", onAbort);
				if (graceTimer) clearTimeout(graceTimer);
			}
		} finally {
			release();
		}
	}

	async snapshotState(): Promise<SnapshotResult | null> {
		const config = this.options.snapshot;
		if (!config || this.state !== "running" || !this.kernel) return null;
		try {
			const reply = await this.kernel.snapshot(config.path, config.maxBytes ?? DEFAULT_SNAPSHOT_MAX_BYTES);
			// --- an incomplete snapshot must not overwrite the last good file ---
			if (reply.complete === false) return null;
			// --- the bridge wrote the file atomically; names and counts only cross the pipe ---
			const saved = reply.saved ?? reply.entries?.map((e) => e.name) ?? [];
			return { path: config.path, saved, failed: reply.failed };
		} catch {
			return null;
		}
	}

	/** Restore outcome (never rejects); the background quiet-gap job — this promise is the lifecycle's only announce hook. */
	restoreResult(): Promise<RestoreResult | null> {
		if (this.restoreSettledResult !== undefined) return Promise.resolve(this.restoreSettledResult);
		if (!this.restorePromise) {
			this.restorePromise = new Promise<RestoreResult | null>((resolve) => {
				this.restoreResolve = resolve;
			});
		}
		return this.restorePromise;
	}

	/** True when the restore was deliberately skipped (prior wedge); lets the lifecycle say exactly why. */
	restoreWasSkipped(): boolean {
		return this.restoreSkipped;
	}

	private settleRestore(result: RestoreResult | null): void {
		if (this.restoreSettledResult !== undefined) return;
		this.restoreSettledResult = result;
		this.restoreResolve?.(result);
		this.restoreResolve = undefined;
	}

	/** Background revive: the bridge runs it at its first quiet gap (never ahead of a user cell);
	 *  mid-session rebuilds force it synchronously instead. */
	private restoreInBackground(): void {
		const config = this.options.snapshot;
		const kernel = this.kernel;
		if (!config || !kernel || this.restoreSkipped) {
			this.settleRestore(null);
			return;
		}
		if (kernel === this.restoredKernel) return; // this kernel already revived
		if (!existsSync(config.path)) {
			this.settleRestore(null);
			return;
		}
		this.restoredKernel = kernel;
		// a poisoned pickle would wedge the bridge's single loop forever — the boot deadline
		// kills and marks the revive skipped instead
		const deadlineMs =
			Number(process.env.PI_REPL_BOOT_TIMEOUT_MS ?? this.options.env?.PI_REPL_BOOT_TIMEOUT_MS ?? 0) ||
			DEFAULT_BOOT_TIMEOUT_MS;
		const reaper = setTimeout(() => {
			this.restoreSkipped = true;
			this.settleRestore(null);
			this.kernel?.kill();
		}, deadlineMs);
		reaper.unref?.();
		kernel
			.restore(config.path, true)
			.then((reply) => {
				clearTimeout(reaper);
				const result: RestoreResult = { path: config.path, restored: reply.restored, failed: reply.failed };
				this.settleRestore(result);
			})
			.catch(() => {
				clearTimeout(reaper);
				this.settleRestore(null);
			});
	}

	/** Restore-cell deadline: a poisoned pickle would wedge the bridge's single loop forever — kill, skip, and rebuild honestly. */
	private async restoreWithReap(): Promise<RestoreResult | null> {
		const config = this.options.snapshot;
		if (!config || !this.kernel || this.restoreSkipped) {
			this.settleRestore(null);
			return null;
		}
		if (this.kernel === this.restoredKernel) return this.restoreResult();
		const deadlineMs =
			Number(process.env.PI_REPL_BOOT_TIMEOUT_MS ?? this.options.env?.PI_REPL_BOOT_TIMEOUT_MS ?? 0) ||
			DEFAULT_BOOT_TIMEOUT_MS;
		const reaper = setTimeout(() => {
			this.restoreSkipped = true;
			this.settleRestore(null);
			this.kernel?.kill();
		}, deadlineMs);
		reaper.unref?.();
		try {
			return await this.restoreState(false).catch(() => null);
		} finally {
			clearTimeout(reaper);
		}
	}

	/** Restore, idempotent per kernel: a second call shares the in-flight outcome. */
	async restoreState(skip = false): Promise<RestoreResult | null> {
		// --- start unconditionally: direct callers may not have started, and a wedged boot is only visible mid-attempt ---
		await this.start();
		if (skip) {
			this.settleRestore(null);
			return null;
		}
		const config = this.options.snapshot;
		const kernel = this.kernel;
		if (!config || !kernel || this.restoreSkipped) {
			this.settleRestore(null);
			return null;
		}
		if (kernel === this.restoredKernel) {
			return this.restoreResult();
		}
		// claim the kernel now so a background revive cannot start a second restore cell
		this.restoredKernel = kernel;
		if (!existsSync(config.path)) {
			this.settleRestore(null);
			return null;
		}
		try {
			// v1/v2/v3 dispatch, un-pickling, and the save-time failure merge all live in the bridge
			const reply = await kernel.restore(config.path);
			const result: RestoreResult = { path: config.path, restored: reply.restored, failed: reply.failed };
			this.settleRestore(result);
			return result;
		} catch {
			this.settleRestore(null);
			return null;
		}
	}

	hasSnapshotHistory(): boolean {
		const config = this.options.snapshot;
		return config ? existsSync(dirname(config.path)) : false;
	}

	async listNamespaceNames(): Promise<string[] | null> {
		if (this.state !== "running" || !this.kernel) return null;
		try {
			return await this.kernel.listNames();
		} catch {
			return null;
		}
	}
}
