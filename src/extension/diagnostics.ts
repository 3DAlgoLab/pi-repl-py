/**
 * Read-only kernel diagnostics for /repl, plus the host-detection rules that replaced the old --repl flag.
 *
 * There is no mode switch any more: pi-fabric owns the model-facing code-mode when it is loaded, and this
 * extension becomes a durable-state sidecar it can call. Fabric's own code gates on the same
 * `getActiveTools().includes("fabric_exec")` check, so this is the sanctioned way to sense the host. Keeping the
 * rule and the formatting here (not inline in index.ts) is what makes them unit-testable without a live pi.
 */

export type HostMode = "takeover" | "sidecar";

/** Plain pi → this extension is the tool surface (the 0.9.0 behaviour). pi-fabric loaded → it is not. */
export function hostMode(activeTools: readonly string[]): HostMode {
	return activeTools.includes("fabric_exec") ? "sidecar" : "takeover";
}

/**
 * The model's tool surface for this host. Under Fabric, `execute` must leave the active set: a second
 * code-mode in the prompt is exactly the conflict, and programs still reach it as
 * `extensions."pi-repl-py".execute`. A takeover collapses to execute-only, as 0.9.0 did.
 */
export function toolsForHost(active: readonly string[], mode: HostMode): string[] {
	return mode === "takeover" ? ["execute"] : active.filter((tool) => tool !== "execute");
}

export interface DiagnosticsView {
	host: HostMode;
	/** True when an engine exists for this conversation (it boots lazily under a sidecar host). */
	enginePresent: boolean;
	kernelState?: "idle" | "starting" | "running" | "shutdown";
	/** Process we spawned — the venv launcher on Windows, the interpreter itself on POSIX. */
	pid?: number;
	/** The bridge process: reads the op stream, owns the ZMQ channels to the kernel. */
	bridgePid?: number;
	/** The ipykernel subprocess: where cells run and where live handles (COM proxies) live. */
	kernelPid?: number;
	interpreter?: string;
	interpreterSource?: string;
	/** Helper files the prompt advertises, by name, and the directories they were read from. */
	helperNames: string[];
	helperDirs: string[];
	snapshotPath?: string;
	/** A namespace file already exists on disk for this conversation. */
	snapshotPresent?: boolean;
}

/**
 * Name each distinct process once. POSIX collapses to two: `bridge 6692 · kernel 25304`.
 *
 * Windows does not. A venv's python.exe is a launcher stub that re-execs, so every Python launch costs two
 * processes — and jupyter_client then spawns ipykernel through that same stub. A live session is therefore a
 * four-process chain: launcher -> bridge -> ipykernel-launcher -> the interpreter that runs cells and holds the
 * COM proxies. The leaf is the one a wedged DraftSight connection belongs to, but no host-side API reports it;
 * what does work is killing the tree from its root, which is why the line below names the root.
 */
function pidSuffix(v: DiagnosticsView): string {
	const roles: [string, number | undefined][] = [];
	if (v.pid !== undefined && v.pid !== v.bridgePid) roles.push(["launcher", v.pid]);
	if (v.bridgePid !== undefined) roles.push(["bridge", v.bridgePid]);
	if (v.kernelPid !== undefined && v.kernelPid !== v.bridgePid) roles.push(["ipykernel", v.kernelPid]);
	return roles.length === 0 ? "" : ` ${roles.map(([role, pid]) => `${role} ${pid}`).join(" · ")}`;
}

/** One line per fact, sized for a toast; nothing here can change state. */
export function formatDiagnostics(v: DiagnosticsView): string {
	const lines: string[] = [];
	lines.push(
		v.host === "takeover"
			? "host: pi (execute is the model's tool surface)"
			: "host: pi-fabric (execute is a sidecar; call it from a program)",
	);
	if (!v.enginePresent) {
		lines.push("engine: not started — it boots on the first cell");
		return lines.join("\n");
	}
	lines.push(`kernel: ${v.kernelState ?? "unknown"}${pidSuffix(v)}`);
	// a hand-kill that names one pid leaves the rest of the chain alive with its COM handles; the tree kill does not
	if (v.pid !== undefined && v.bridgePid !== undefined && v.pid !== v.bridgePid) {
		lines.push(`leaked kernel? kill the tree from its root: taskkill /PID ${v.pid} /T /F`);
	}
	lines.push(`python: ${v.interpreter ?? "unresolved"}${v.interpreterSource ? ` (${v.interpreterSource})` : ""}`);
	lines.push(`helpers: ${v.helperNames.length === 0 ? "none" : v.helperNames.join(", ")}`);
	lines.push(`helper dirs: ${v.helperDirs.length === 0 ? "none" : v.helperDirs.join(", ")}`);
	lines.push(
		`snapshot: ${v.snapshotPath ?? "disabled (ephemeral session)"}` +
			(v.snapshotPresent === undefined ? "" : v.snapshotPresent ? " · namespace on disk" : " · nothing written yet"),
	);
	return lines.join("\n");
}
