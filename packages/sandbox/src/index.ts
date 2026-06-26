/**
 * @turjuman/sandbox — the code-mode execution engine.
 *
 * Runs untrusted TypeScript/JavaScript in a QuickJS-WASM isolate whose ONLY
 * capability is the `@turjuman/sdk` operation registry, reached through an
 * in-process host broker. The guest has no network, filesystem, environment, or
 * timers; each `turjuman.<operation>(args)` call is dispatched to the same
 * handler a normal MCP tool call or REST route runs, with the request's
 * authenticated context. Only the final (size-bounded) result returns.
 *
 * The host broker (`createOpDispatcher`) is the swappable seam: today it resolves
 * operations in-process; the deferred hardening variant can replace it with an
 * HTTPS call to a grant-less function without changing the guest contract.
 */
import type { OpContext } from "@turjuman/sdk";
import { createOpDispatcher } from "./dispatcher.js";
import { type EvalRequest, evalInSandbox, type RunResult } from "./engine.js";
import type { SandboxLimits } from "./limits.js";
import { generateStubSource } from "./stubs.js";

export type { OpDispatcher } from "./dispatcher.js";
export { createOpDispatcher } from "./dispatcher.js";
export type { EvalRequest, RunResult, SandboxLogEntry } from "./engine.js";
export { evalInSandbox } from "./engine.js";
export type { SandboxLimits } from "./limits.js";
export { DEFAULT_LIMITS, resolveLimits } from "./limits.js";
export { generateStubSource } from "./stubs.js";

/** A code-mode run, wired for in-process execution: the default host broker
 * resolves `@turjuman/sdk` operations with `ctx`, and the guest sees the full
 * `turjuman.*` surface. This is what the MCP `run_code` tool calls. */
export interface RunCodeRequest {
	code: string;
	ctx: OpContext;
	limits?: Partial<SandboxLimits>;
}

export async function runCode(req: RunCodeRequest): Promise<RunResult> {
	const request: EvalRequest = {
		code: req.code,
		dispatch: createOpDispatcher(req.ctx),
		stubSource: generateStubSource(),
		limits: req.limits,
	};
	return evalInSandbox(request);
}
