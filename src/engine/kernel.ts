// --- KernelClient over one stdio pipe: bridge.py owns ipykernel and the Jupyter protocol;
// --- this side spawns it, speaks one JSON line at a time, and applies the output caps. ---

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHelperDirs } from "./helpers-locate.js";

// An interrupt is asynchronous, and on Windows it is a Win32 event the kernel's poller thread has to
// notice: measured at ~0.3s for a busy cell, but a kernel inside a C call can take longer. Killing on a
// 2s grace turns a recoverable interrupt into a lost namespace, so the grace is deliberately generous --
// the watchdog re-interrupts every tick meanwhile, so a genuinely wedged cell is still reaped.
const SILENCE_KILL_GRACE_MS = 4000;
/** The bridge ships at the package root, next to index.ts; src/engine is two levels deep. */
const BRIDGE_PATH = fileURLToPath(new URL("../../bridge.py", import.meta.url));

export interface KernelOptions {
	cwd?: string;
	env?: Record<string, string>;
	/** Silence watchdog in ms; 0 = no cap (a silent-but-working cell may run on). */
	timeoutMs?: number;
	/** When present, the bridge self-schedules snapshots in its own quiet gaps. */
	snapshot?: { path: string; max_bytes: number; period_ms: number };
}

export interface CellResult {
	stdout: string;
	stderr: string;
	result?: string;
	error?: { name: string; message: string; stack: string[] };
	status: "ok" | "error" | "aborted";
	truncated?: { stdout: boolean; stderr: boolean };
}

export interface CellOptions {
	signal?: AbortSignal;
	onStream?: (chunk: string, name: "stdout" | "stderr") => void;
	/** The engine owns cap policy (DEFAULT_MAX_OUTPUT_CHARS); the kernel is transport and must not default its own. */
	maxOutputChars: number;
}

export interface SnapshotReply {
	/** Names persisted; payloads never cross the pipe — the bridge wrote the file itself. */
	saved?: string[];
	/** Only present for tests that fake the kernel; the real bridge replies with counts only. */
	entries?: { name: string; kind: "value" | "def"; payload: string }[];
	failed: { name: string; reason: string }[];
	complete: boolean;
	/** Payload bytes written; drives the periodic-refresh stand-down. */
	bytes?: number;
}

export interface HelperLoadResult {
	name: string;
	ok: boolean;
	/** First error line, e.g. "NameError: name 'x' is not defined"; undefined when ok. */
	error?: string;
}

interface BridgeMessage {
	type?: string;
	id?: string;
	[key: string]: unknown;
}

interface ActiveCell {
	id: string;
	stdout: string[];
	stderr: string[];
	outLen: number;
	errLen: number;
	maxChars: number;
	result?: string;
	error?: { name: string; message: string; stack: string[] };
	status: CellResult["status"];
	lastActivity: number;
	timedOut: boolean;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	signal?: AbortSignal;
	onStream?: (chunk: string, name: "stdout" | "stderr") => void;
	resolve(result: CellResult): void;
	reject(error: Error): void;
	settled: boolean;
}

interface PendingRequest {
	resolve(msg: BridgeMessage): void;
	reject(error: Error): void;
	timer?: ReturnType<typeof setTimeout>;
}

/** Kernel cwd falls back to the host cwd when the requested dir is gone (a deleted project is a real resume case). */
function resolveCwd(requested?: string): string {
	if (requested && existsSync(requested)) return requested;
	return process.cwd();
}

/** Read the helpers dir (same skip rules as the extension's prompt loader); sources travel in the boot line. */
function readHelperSources(dirs: string[]): { name: string; source: string }[] {
	// --- merged dirs come pre-ordered (project first, global last); first-seen name wins ---
	const seen = new Set<string>();
	const out: { name: string; source: string }[] = [];
	for (const d of dirs) {
		if (!existsSync(d)) continue;
		for (const file of readdirSync(d).sort()) {
			if (!file.endsWith(".py")) continue;
			const name = file.slice(0, -3);
			if (!/^[A-Za-z_]\w*$/.test(name) || name.startsWith("_")) continue;
			if (seen.has(name)) continue;
			seen.add(name);
			try {
				out.push({ name, source: readFileSync(join(d, file), "utf8") });
			} catch {}
		}
	}
	return out;
}

/**
 * Kill the bridge AND the ipykernel it spawned. POSIX: the detached spawn made the bridge a group
 * leader, so one group signal covers both. Windows has no process groups, and killing only the bridge
 * orphans the ipykernel — which keeps holding whatever it opened (a COM apartment, an open document,
 * a database connection) with nobody left to release it.
 */
export function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		const r = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
		if (!r.error) return;
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
}

export class KernelClient {
	private child?: ChildProcess;
	private bridgePid_?: number;
	private kernelProcPid_?: number;
	private readonly timeoutMs: number;
	private ready = false;
	/** Serializes all kernel ops: one execute at a time, snapshots between cells. */
	private queue: Promise<unknown> = Promise.resolve();
	private pending = new Map<string, PendingRequest>();
	private activeCell?: ActiveCell;
	private inputBuffer = "";
	private readyWaiters: { resolve(msg: BridgeMessage): void; reject(error: Error): void }[] = [];
	private helperBootReport: HelperLoadResult[] = [];
	private nextId = 0;
	private _onUnexpectedExit?: () => void;
	private watchdog?: ReturnType<typeof setInterval>;
	private silenceKillTimer?: ReturnType<typeof setTimeout>;

	private constructor(opts: KernelOptions) {
		this.timeoutMs = opts.timeoutMs ?? 0;
	}

	static async start(argv: string[], opts: KernelOptions = {}): Promise<KernelClient> {
		if (argv.length === 0) throw new Error("no Python interpreter to launch the bridge with");
		const child = spawn(argv[0], [...argv.slice(1), BRIDGE_PATH], {
			cwd: resolveCwd(opts.cwd),
			env: { ...process.env, ...(opts.env ?? {}) },
			stdio: ["pipe", "pipe", "pipe"],
			// POSIX only: make the bridge a group leader so killProcessTree reaches the ipykernel too
			detached: process.platform !== "win32",
			windowsHide: true,
		});
		// keep stderr for post-mortems (ipykernel warnings, bridge tracebacks)
		let stderrTail = "";
		child.stderr?.on("data", (b: Buffer) => {
			stderrTail = (stderrTail + b.toString()).slice(-4000);
		});

		const kc = new KernelClient(opts);
		kc.child = child;
		child.stdout?.on("data", (chunk) => kc.onData(chunk));
		child.on("exit", () => {
			// --- bridge exit IS kernel death: settle the running cell and drop the zombie ---
			kc.settleActive(new Error("kernel process exited"));
			// --- every in-flight op must answer: a snapshot promise left unsettled by a dead bridge
			// --- hangs dispose(), which hangs session_shutdown, which leaves the process group alive ---
			kc.rejectPending(new Error("kernel process exited"));
			kc.stopWatchdog();
			kc.ready = false;
			kc.child = undefined;
			kc.rejectBootWaiters(new Error("bridge exited before it was ready"));
			kc._onUnexpectedExit?.();
		});

		// helpers resolve host-side (one canonical list, same skip rules as the prompt); sources preload in the bridge
		const helpers = (
			opts.env?.PI_HELPERS_DIR
				? readHelperSources([opts.env.PI_HELPERS_DIR])
				: readHelperSources(resolveHelperDirs(opts.cwd, opts.env?.PI_HELPERS_GLOBAL_DIR))
		).map((h) => ({ name: h.name, source: h.source }));
		kc.send({ op: "boot", helpers, snapshot: opts.snapshot });

		try {
			await kc.waitReady();
		} catch (error) {
			kc.kill();
			throw error instanceof Error
				? new Error(`${error.message}${stderrTail ? `\nbridge stderr:\n${stderrTail}` : ""}`)
				: error;
		}
		kc.ready = true;
		return kc;
	}

	private onData(chunk: Uint8Array): void {
		this.inputBuffer += Buffer.from(chunk).toString("utf8");
		let idx = this.inputBuffer.indexOf("\n");
		while (idx >= 0) {
			const line = this.inputBuffer.slice(0, idx).trim();
			this.inputBuffer = this.inputBuffer.slice(idx + 1);
			if (line) this.handleLine(line);
			idx = this.inputBuffer.indexOf("\n");
		}
	}

	/** Route-gate: a line that is not valid JSON is not the bridge. */
	private handleLine(line: string): void {
		let msg: BridgeMessage;
		try {
			msg = JSON.parse(line) as BridgeMessage;
		} catch {
			console.error("[pi-repl] unparseable bridge line:", line.slice(0, 200));
			return;
		}
		switch (msg.type) {
			case "ready": {
				const helpers = Array.isArray(msg.helpers) ? (msg.helpers as HelperLoadResult[]) : [];
				this.helperBootReport = helpers;
				// Three pids matter on Windows: the venv launcher we spawned (child.pid), the bridge process,
				// and the ipykernel child that executes cells and holds live handles. Only the last one is what a
				// stray DraftSight connection belongs to.
				if (typeof msg.pid === "number") this.bridgePid_ = msg.pid;
				if (typeof msg.kernel_pid === "number") this.kernelProcPid_ = msg.kernel_pid;
				this.readyWaiters.shift()?.resolve(msg);
				break;
			}
			case "stream": {
				const active = this.activeCell;
				if (active && msg.id === active.id) {
					active.lastActivity = Date.now();
					this.accumulate(active, msg.name === "stderr" ? "stderr" : "stdout", String(msg.text ?? ""));
				}
				break;
			}
			case "result": {
				const active = this.activeCell;
				if (active && msg.id === active.id) this.settleFromResult(active, msg);
				break;
			}
			case "reply": {
				const id = msg.id;
				if (id !== undefined) {
					const pending = this.pending.get(id);
					if (pending) {
						this.pending.delete(id);
						if (pending.timer) clearTimeout(pending.timer);
						pending.resolve(msg);
					}
				}
				break;
			}
			case "error": {
				const error = new Error(String(msg.message ?? "bridge error"));
				const id = msg.id;
				if (id !== undefined && this.pending.has(id)) {
					const pending = this.pending.get(id)!;
					this.pending.delete(id);
					if (pending.timer) clearTimeout(pending.timer);
					pending.reject(error);
				} else if (id !== undefined && this.activeCell?.id === id) {
					// bridge.py answers a failed op with the op's id ("unknown op", an exec that raised
					// inside the bridge). Only pending ops are routed by id, so a cell that gets an
					// error line instead of a result would sit unsettled forever — the silence watchdog
					// is off unless PI_REPL_TIMEOUT_MS is set, and every later cell queues behind it.
					this.settleFromBridgeError(this.activeCell!, error.message);
				} else if (this.readyWaiters.length > 0) {
					this.readyWaiters.shift()!.reject(error); // boot failure
				} else {
					console.error("[pi-repl] bridge error:", error.message);
				}
				break;
			}
			default:
				console.error("[pi-repl] unknown bridge event:", JSON.stringify(msg).slice(0, 200));
		}
	}

	private send(msg: object): void {
		this.child?.stdin?.write(`${JSON.stringify(msg)}\n`);
	}

	/** Resolves on the bridge's ready event; rejects on a boot error or a bridge exit.
	 *  A wedged (alive but silent) bridge is bounded by the lifecycle's boot race. */
	private waitReady(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			this.readyWaiters.push({ resolve: () => resolve(), reject });
		});
	}

	private rejectBootWaiters(error: Error): void {
		const waiters = this.readyWaiters.splice(0);
		for (const w of waiters) w.reject(error);
	}

	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.queue.then(fn, fn);
		this.queue = result.catch(() => {});
		return result;
	}

	/** A request/reply op: snapshot, restore, listNames, shutdown. Serialized with cells. */
	private request(msg: Record<string, unknown>, timeoutMs?: number): Promise<BridgeMessage> {
		return this.enqueue(() => {
			const id = `r${this.nextId++}`;
			return new Promise<BridgeMessage>((resolve, reject) => {
				const timer = timeoutMs
					? setTimeout(() => {
							this.pending.delete(id);
							reject(new Error(`bridge did not answer ${String(msg.op)} in time`));
						}, timeoutMs)
					: undefined;
				timer?.unref?.();
				this.pending.set(id, { resolve, reject, timer });
				this.send({ ...msg, id });
			});
		});
	}

	executeCell(code: string, opts: CellOptions): Promise<CellResult> {
		return this.enqueue(() => this.executeCellNow(code, opts));
	}

	private executeCellNow(code: string, opts: CellOptions): Promise<CellResult> {
		const maxChars = opts.maxOutputChars;
		// one op id per request; the bridge echoes it on every stream and the result event
		const id = `e${this.nextId++}`;
		const active: ActiveCell = {
			id,
			stdout: [],
			stderr: [],
			outLen: 0,
			errLen: 0,
			maxChars,
			lastActivity: Date.now(),
			timedOut: false,
			stdoutTruncated: false,
			stderrTruncated: false,
			signal: opts.signal,
			onStream: opts.onStream,
			status: "ok",
			settled: false,
			resolve: () => {},
			reject: () => {},
		};
		this.activeCell = active;
		const onAbort = () => this.requestInterrupt();
		opts.signal?.addEventListener("abort", onAbort, { once: true });

		this.send({ op: "exec", id, code });
		this.startWatchdog(active);

		return new Promise<CellResult>((resolve, reject) => {
			active.resolve = resolve;
			active.reject = reject;
			if (opts.signal?.aborted) this.requestInterrupt();
		}).finally(() => {
			if (this.activeCell === active) this.activeCell = undefined;
			this.stopWatchdog();
			opts.signal?.removeEventListener("abort", onAbort);
		});
	}

	/** A cell the bridge refused: report it as a failed cell, not a transport rejection. */
	private settleFromBridgeError(active: ActiveCell, message: string): void {
		if (active.settled) return;
		active.settled = true;
		active.status = "error";
		active.error = { name: "BridgeError", message, stack: [] };
		this.stopWatchdog();
		active.resolve({
			stdout: active.stdout.join(""),
			stderr: active.stderr.join(""),
			result: undefined,
			error: active.error,
			status: "error",
			truncated: { stdout: active.stdoutTruncated, stderr: active.stderrTruncated },
		});
	}

	/** Reject every queued request op (snapshot, restore, listNames, shutdown). */
	private rejectPending(error: Error): void {
		for (const [id, pending] of this.pending) {
			if (pending.timer) clearTimeout(pending.timer);
			this.pending.delete(id);
			pending.reject(error);
		}
	}

	private settleActive(error: Error): void {
		const active = this.activeCell;
		if (!active || active.settled) return;
		active.settled = true;
		active.reject(error);
	}

	private settleFromResult(active: ActiveCell, msg: BridgeMessage): void {
		// the bridge settles only once the shell reply AND the iopub idle arrived
		if (active.settled) return;
		active.settled = true;
		const content = msg as {
			status?: string;
			result?: string;
			error?: { name?: string; message?: string; stack?: string[] };
		};
		if (content.result !== undefined) active.result = content.result;
		if (content.error) {
			active.error = {
				name: content.error.name ?? "Error",
				message: content.error.message ?? "",
				stack: content.error.stack ?? [],
			};
		}
		let status: CellResult["status"] = content.status === "aborted" ? "aborted" : active.error ? "error" : "ok";
		if (active.signal?.aborted) {
			// the caller withdrew; report aborted even if the cell raised
			status = "aborted";
		} else if (active.timedOut) {
			// --- the watchdog already interrupted this cell. If the kernel answered by cutting it, say so:
			// --- ipykernel reports an interrupted exec as an error named KeyboardInterrupt (status "aborted"
			// --- is reserved for cells that never started), and in that case the kernel is idle and the
			// --- namespace is intact. Only a cell that outran the interrupt and answered normally is a
			// --- genuine timeout -- that one may still be running, and that is the case worth alarming about ---
			const cutByInterrupt = content.status === "aborted" || active.error?.name === "KeyboardInterrupt";
			if (cutByInterrupt) {
				status = "aborted";
				active.error = active.error ?? { name: "KeyboardInterrupt", message: "cell interrupted", stack: [] };
			} else {
				status = "error";
				active.error = {
					name: "Timeout",
					message: "cell did not finish within the silence window and may still be running",
					stack: ["[cell timed out]"],
				};
			}
		}
		active.status = status;
		active.resolve({
			stdout: active.stdout.join(""),
			stderr: active.stderr.join(""),
			result: active.result,
			error: active.error,
			status,
			truncated: { stdout: active.stdoutTruncated, stderr: active.stderrTruncated },
		});
	}

	private accumulate(active: ActiveCell, name: "stdout" | "stderr", text: string): void {
		const arr = name === "stdout" ? active.stdout : active.stderr;
		const len = name === "stdout" ? active.outLen : active.errLen;
		const room = active.maxChars - len;
		const keep = Math.min(text.length, Math.max(0, room));
		if (keep > 0) {
			arr.push(text.slice(0, keep));
			if (name === "stdout") active.outLen += keep;
			else active.errLen += keep;
		}
		// one oversized stream frame (10 MB print) overflows the cap within this call
		if (text.length > keep) {
			if (name === "stdout") active.stdoutTruncated = true;
			else active.stderrTruncated = true;
		}
		// beyond the cap we drop text but keep draining
		active.onStream?.(text.slice(0, keep), name);
	}

	private startWatchdog(active: ActiveCell): void {
		this.stopWatchdog();
		if (!this.timeoutMs) return;
		this.watchdog = setInterval(
			() => {
				const quiet = Date.now() - active.lastActivity;
				if (quiet >= this.timeoutMs && !active.settled) {
					active.timedOut = true;
					this.requestInterrupt();
					// a cell that swallows the interrupt never replies; escalate to a kill so the queue frees
					this.silenceKillTimer ??= setTimeout(() => {
						if (!active.settled) this.kill();
					}, SILENCE_KILL_GRACE_MS);
					this.silenceKillTimer.unref?.();
				}
			},
			Math.min(250, this.timeoutMs),
		);
		this.watchdog.unref?.();
	}

	private stopWatchdog(): void {
		if (this.watchdog) {
			clearInterval(this.watchdog);
			this.watchdog = undefined;
		}
		if (this.silenceKillTimer) {
			clearTimeout(this.silenceKillTimer);
			this.silenceKillTimer = undefined;
		}
	}

	/**
	 * Ask the bridge to raise KeyboardInterrupt in the active cell. This method sends one op; the bridge
	 * picks the mechanism per platform -- a Win32 event handle the kernel's poller thread already waits
	 * on (jupyter_client 8.x dropped interrupt() from BlockingKernelClient and the control channel is a
	 * no-op there), or the control-channel request elsewhere. Measured ~0.3s to settle for a busy cell.
	 */
	requestInterrupt(): void {
		this.send({ op: "interrupt" });
	}

	snapshot(path: string, maxBytes: number): Promise<SnapshotReply> {
		return this.request({ op: "snapshot", path, max_bytes: maxBytes }).then((msg) => {
			const m = msg as {
				saved?: string[];
				entries?: { name: string; kind: "value" | "def"; payload: string }[];
				failed?: { name: string; reason: string }[];
				complete?: boolean;
				bytes?: number;
				error?: string;
			};
			if (m.error !== undefined || m.complete === undefined) {
				throw new Error(String(m.error ?? "snapshot failed"));
			}
			return { saved: m.saved, entries: m.entries, failed: m.failed ?? [], complete: m.complete, bytes: m.bytes };
		});
	}

	restore(path: string, defer = false): Promise<{ restored: string[]; failed: { name: string; reason: string }[] }> {
		if (defer) {
			// background revive: bypass the op queue — a queued restore would hold every user
			// cell behind its completion. The bridge runs it at its first quiet gap instead.
			const id = `r${this.nextId++}`;
			return new Promise<BridgeMessage>((resolve, reject) => {
				this.pending.set(id, { resolve, reject });
				this.send({ op: "restore", path, defer: true, id });
			}).then((msg) => {
				const m = msg as { restored?: string[]; failed?: { name: string; reason: string }[]; error?: string };
				if (m.error !== undefined) throw new Error(m.error);
				return { restored: m.restored ?? [], failed: m.failed ?? [] };
			});
		}
		return this.request({ op: "restore", path }).then((msg) => {
			const m = msg as { restored?: string[]; failed?: { name: string; reason: string }[]; error?: string };
			if (m.error !== undefined) throw new Error(m.error);
			return { restored: m.restored ?? [], failed: m.failed ?? [] };
		});
	}

	listNames(): Promise<string[]> {
		return this.request({ op: "listNames" }).then((msg) => {
			const names = (msg as { names?: unknown }).names;
			return Array.isArray(names) ? (names as string[]) : [];
		});
	}

	/** Graceful stop: shutdown op, then SIGKILL the process group as backstop. */
	async shutdown(): Promise<void> {
		if (this.ready && this.child) {
			await this.request({ op: "shutdown" }, 2000).catch(() => {});
		}
		this.kill();
	}

	kill(): void {
		this.stopWatchdog();
		this.settleActive(new Error("kernel killed"));
		this.rejectPending(new Error("kernel killed"));
		this.ready = false;
		const pid = this.child?.pid;
		if (pid !== undefined) killProcessTree(pid);
		this.child = undefined;
	}

	/** Engine hook: an unexpected bridge exit (not a deliberate kill) should drop the instance. */
	setOnUnexpectedExit(fn: () => void): void {
		this._onUnexpectedExit = fn;
	}

	get helperReport(): readonly HelperLoadResult[] {
		return this.helperBootReport;
	}

	/** A cell is executing right now; a shutdown snapshot would queue behind it. */
	get hasActiveCell(): boolean {
		return this.activeCell !== undefined && !this.activeCell.settled;
	}

	get isRunning(): boolean {
		return this.ready && this.child !== undefined && this.child.exitCode === null;
	}

	/**
	 * Process roles, all three for diagnostics. On POSIX they collapse to two numbers; on Windows a venv's
	 * python.exe re-execs and jupyter_client spawns ipykernel as a grandchild, so the pid holding a live COM
	 * proxy is `kernelPid`, and `taskkill /T` is the only thing that reaches it.
	 */
	get pid(): number | undefined {
		return this.child?.pid;
	}

	/** The bridge process itself (reads the op stream, owns the ZMQ channels). */
	get bridgePid(): number | undefined {
		return this.bridgePid_;
	}

	/** The ipykernel subprocess: where cells run and where live handles live. */
	get kernelPid(): number | undefined {
		return this.kernelProcPid_;
	}
}
