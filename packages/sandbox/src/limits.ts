/**
 * Resource limits enforced on a single `run_code` execution. Defaults are sized
 * for the MCP Lambda (15s timeout, 256 MB) with headroom: a run is capped well
 * under the function's own limits so a runaway script fails fast with a clean
 * error instead of a Lambda timeout.
 */
export interface SandboxLimits {
	/** Wall-clock budget for the whole run, enforced via the QuickJS interrupt
	 * handler (so even a tight `while(true){}` is stopped). */
	timeoutMs: number;
	/** Hard memory ceiling for the QuickJS runtime, in bytes. */
	memoryBytes: number;
	/** Max serialized size of the returned result; larger output is truncated. */
	maxOutputBytes: number;
	/** Max number of `turjuman.*` (bridge) calls in one run — a backstop against a
	 * script that loops over an operation forever within the time budget. */
	maxOps: number;
	/** Max number of captured `console.*` log entries; further logs are dropped. */
	maxLogs: number;
	/** Max total bytes of captured `console.*` output; further logs are dropped.
	 * Bounds the log payload independently of `maxOutputBytes` (logs ride back to
	 * the model alongside the result), so many large lines can't blow its context. */
	maxLogBytes: number;
}

export const DEFAULT_LIMITS: SandboxLimits = {
	timeoutMs: 5_000,
	memoryBytes: 64 * 1024 * 1024,
	maxOutputBytes: 256 * 1024,
	maxOps: 1_000,
	maxLogs: 200,
	maxLogBytes: 64 * 1024,
};

/** Merge caller overrides onto the defaults. */
export function resolveLimits(
	overrides?: Partial<SandboxLimits>,
): SandboxLimits {
	return { ...DEFAULT_LIMITS, ...overrides };
}
