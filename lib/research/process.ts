/**
 * Spawns src/research/helper.py with the recorded isolated interpreter,
 * feeds one JSON request on stdin, and reads NDJSON events from stdout.
 *
 * Rules from docs/spec/RESEARCH_SPEC.md:
 * - stderr is a log channel; a malformed stdout line fails the call (6.1).
 * - The final result is built only from batch_finished plus collected
 *   events; fatal_error surfaces as a thrown failure (6.1).
 * - Cancellation kills the whole local process tree and settles once; a
 *   cancelled call never later flips into success when a late child event
 *   arrives (section 9, INV-3 and INV-11).
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assertBatchId, parseHelperEvent, type HelperEvent, type HelperRequest } from "./protocol.js";

/** Interpreter resolution: no machine-absolute path anywhere. The environment
 * is discovered and verified, so typing `pi` is the whole setup. */
const DEPENDENCY_PROBE = "import importlib.util as u; assert u.find_spec('scrapling') and u.find_spec('orjson')";
const PROBE_TIMEOUT_MS = 20_000;

const INTERPRETER_HINT = " (no Python with scrapling and orjson was found; create a conda environment named scrapling with those packages, or set PI_REMOTICON_PYTHON to such an interpreter)";

/** True when the candidate can see both helper dependencies (no heavy import). */
function interpreterHasDependencies(interpreter: string): boolean {
	const probe = spawnSync(interpreter, ["-c", DEPENDENCY_PROBE], { timeout: PROBE_TIMEOUT_MS, windowsHide: true, stdio: "ignore" });
	return probe.status === 0;
}

/** Interpreter paths of conda environments named "scrapling" in `conda env list --json` output. */
export function scraplingInterpretersFromCondaEnvs(condaJson: string): string[] {
	try {
		const parsed = JSON.parse(condaJson) as { envs?: unknown };
		if (!Array.isArray(parsed.envs)) return [];
		return parsed.envs
			.filter((value): value is string => typeof value === "string" && /(^|[\\/])scrapling$/.test(value))
			.map((env) => process.platform === "win32" ? join(env, "python.exe") : join(env, "bin", "python"));
	} catch {
		return [];
	}
}

function condaLocatedInterpreters(): string[] {
	const listed = spawnSync("conda", ["env", "list", "--json"], { timeout: PROBE_TIMEOUT_MS, windowsHide: true, encoding: "utf8" });
	if (listed.status !== 0 || typeof listed.stdout !== "string") return [];
	return scraplingInterpretersFromCondaEnvs(listed.stdout);
}

/** Candidates in order: an explicit override wins, then PATH, then conda environments named scrapling. */
export function helperInterpreterCandidates(condaEnvs: () => string[] = condaLocatedInterpreters): string[] {
	const configured = process.env.PI_REMOTICON_PYTHON?.trim();
	if (configured) return [configured];
	const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
	const defaults = home === "" ? [] : [join(home, "miniconda3", "envs", "scrapling"), join(home, "anaconda3", "envs", "scrapling")]
		.map((env) => process.platform === "win32" ? join(env, "python.exe") : join(env, "bin", "python"));
	return [process.platform === "win32" ? "python" : "python3", ...defaults, ...condaEnvs()];
}

/** The first candidate that can see scrapling and orjson; the PATH name last,
 * so a total miss still fails with the install hint rather than a bad answer. */
export function resolveHelperInterpreter(
	probe: (interpreter: string) => boolean = interpreterHasDependencies,
	candidates: () => string[] = () => helperInterpreterCandidates(),
): string {
	const configured = process.env.PI_REMOTICON_PYTHON?.trim();
	if (configured) return configured;
	const list = candidates();
	for (const candidate of list) {
		if (probe(candidate)) return candidate;
	}
	return list[0] ?? (process.platform === "win32" ? "python" : "python3");
}

/** Resolution runs once per process: the probe costs a second or two. */
let cachedInterpreter: string | null = null;

function interpreterForSpawn(): string {
	cachedInterpreter ??= resolveHelperInterpreter();
	return cachedInterpreter;
}

/** Absolute path of helper.py next to this module; valid under jiti and vitest. */
export function helperScriptPath(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "helper.py");
}

const MAX_STDERR_CAPTURE = 16 * 1024;
const STDERR_TAIL_SHOWN = 600;
export const DEFAULT_HELPER_DEADLINE_MS = 40_000;

export class HelperCancelledError extends Error {
	constructor(reason: string) {
		super(`fetch cancelled: ${reason}`);
		this.name = "HelperCancelledError";
	}
}

/** The helper exceeded its wall-clock budget. Completed events stay available. */
export class HelperDeadlineError extends Error {
	constructor(
		public readonly timeoutMs: number,
		public readonly events: readonly HelperEvent[],
	) {
		super(`fetch deadline exceeded after ${Math.round(timeoutMs / 1000)} seconds`);
		this.name = "HelperDeadlineError";
	}
}

/** Test hook: spawn a stand-in process instead of the real helper. Tests only. */
export type SpawnOverride = () => ChildProcess;

export interface HelperRun {
	/** Settles once with the accumulated events in arrival order, or rejects. */
	completion: Promise<HelperEvent[]>;
	/** Resolves once the child exited (or failed to spawn). */
	exitInfo: Promise<{ code: number | null }>;
	/** Kills the full local tree, awaits exit, and lets the settlement land. */
	cancel(reason: string): Promise<void>;
}

/** Terminate the whole child tree on Windows; kill() alone only kills python.exe. */
function killProcessTree(child: ChildProcess): void {
	if (process.platform === "win32" && child.pid !== undefined) {
		try {
			spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
		} catch {
			// Falls through to the plain kill below.
		}
	}
	try {
		child.kill();
	} catch {
		// Already exiting.
	}
}

function tailText(text: string, max: number): string {
	return text.length <= max ? text : `…${text.slice(-max)}`;
}

export function runHelper(
	request: HelperRequest,
	signal?: AbortSignal,
	onEvent?: (event: HelperEvent) => void,
	spawnForTest?: SpawnOverride,
	deadlineMs = DEFAULT_HELPER_DEADLINE_MS,
): HelperRun {
	const events: HelperEvent[] = [];
	let settled = false;
	let cancelled = false;
	let cancelReason = "user escape";
	let timedOut = false;
	let completingEvent: "batch_finished" | "fatal_error" | null = null;
	const stderrChunks: Buffer[] = [];
	let stderrBytes = 0;

	let resolveExit!: (value: { code: number | null }) => void;
	const exitInfo = new Promise<{ code: number | null }>((resolve) => {
		resolveExit = resolve;
	});

	let resolveCompletion!: (value: HelperEvent[]) => void;
	let rejectCompletion!: (reason: unknown) => void;
	const completion = new Promise<HelperEvent[]>((resolve, reject) => {
		resolveCompletion = resolve;
		rejectCompletion = reject;
	});

	function settle(kind: "resolve" | "reject", payload: unknown): void {
		if (settled) return;
		settled = true;
		clearTimeout(deadlineTimer);
		if (kind === "resolve") resolveCompletion(payload as HelperEvent[]);
		else rejectCompletion(payload);
	}

	function stderrTailText(limit: number): string {
		const text = Buffer.concat(stderrChunks).toString("utf8").trimEnd();
		if (text.length === 0) return "";
		const prefix = ` (helper stderr: ${tailText(text, limit)}${stderrBytes >= MAX_STDERR_CAPTURE ? " [tail truncated]" : ""})`;
		return prefix;
	}

	const child = spawnForTest
		? spawnForTest()
		: spawn(interpreterForSpawn(), [helperScriptPath()], {
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});

	// A Scrapling or browser wait can outlive its own operation timeout. This
	// wall-clock deadline is the final guard and kills the entire local tree.
	const deadlineTimer = setTimeout(() => {
		if (settled) return;
		timedOut = true;
		completingEvent = null;
		killProcessTree(child);
	}, deadlineMs);
	deadlineTimer.unref?.();

	// stdin: one versioned JSON request, then close the write side immediately.
	const stdin = child.stdin;
	if (stdin) {
		stdin.on("error", () => { /* EPIPE after an early helper exit; the exit handler decides. */ });
		stdin.write(JSON.stringify(request) + "\n");
		stdin.end();
	}

	// stderr: log sink only, bounded capture for failure diagnostics.
	const childErr = child.stderr;
	if (childErr) {
		childErr.on("data", (chunk: Buffer) => {
			const room = MAX_STDERR_CAPTURE - stderrBytes;
			if (room <= 0) return;
			const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
			stderrChunks.push(piece);
			stderrBytes += piece.length;
		});
	}

	// stdout: strictly-validated NDJSON. Any junk kills the tree and fails the call.
	const childOut = child.stdout;
	const lines = childOut ? createInterface({ input: childOut }) : null;
	if (lines) {
		lines.on("line", (line: string) => {
			if (settled) return;
			let event: HelperEvent | null;
			try {
				event = parseHelperEvent(line);
			} catch (error) {
				killProcessTree(child);
				settle("reject", error);
				return;
			}
			if (event === null) return;
			try {
				assertBatchId(event, request.batchId);
			} catch (error) {
				killProcessTree(child);
				settle("reject", error);
				return;
			}
			if (event.type === "batch_finished" || event.type === "fatal_error") {
				completingEvent = event.type;
			}
			events.push(event);
			try {
				onEvent?.(event);
			} catch {
				// A pending-row consumer must not break the protocol reader.
			}
		});
	}

	// Cancellation: settle-first wins; late events are ignored after settle.
	const onAbort = (): void => {
		if (settled) return;
		cancelled = true;
		completingEvent = null; // a cancel always rejects, even if batch_finished just showed up
		killProcessTree(child);
	};
	if (signal) {
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	}

	// Process outcomes.
	child.on("exit", (code) => {
		resolveExit({ code });
		if (signal) signal.removeEventListener("abort", onAbort);
		lines?.close();
		if (settled) return;
		if (timedOut) {
			settle("reject", new HelperDeadlineError(deadlineMs, [...events]));
		} else if (cancelled) {
			settle("reject", new HelperCancelledError(cancelReason));
		} else if (completingEvent === "batch_finished") {
			settle("resolve", events);
		} else if (completingEvent === "fatal_error") {
			const fatal = events.find((event): event is Extract<HelperEvent, { type: "fatal_error" }> => event.type === "fatal_error");
			settle("reject", new Error(`fetch helper failed: ${fatal?.error ?? "unknown fatal error"}${stderrTailText(STDERR_TAIL_SHOWN)}${INTERPRETER_HINT}`));
		} else {
			settle("reject", new Error(`helper exited (code ${code}) without batch_finished${stderrTailText(STDERR_TAIL_SHOWN)}${INTERPRETER_HINT}`));
		}
	});
	child.on("error", (error) => {
		resolveExit({ code: null });
		if (signal) signal.removeEventListener("abort", onAbort);
		lines?.close();
		settle("reject", new Error(`failed to start fetch helper: ${error.message}${stderrTailText(STDERR_TAIL_SHOWN)}${INTERPRETER_HINT}`));
	});

	return {
		completion,
		exitInfo,
		cancel: async (reason: string): Promise<void> => {
			if (!settled) {
				cancelled = true;
				cancelReason = reason;
				completingEvent = null;
				killProcessTree(child);
			}
			if (signal) signal.removeEventListener("abort", onAbort);
			await exitInfo;
		},
	};
}
