import variant from "@jitl/quickjs-singlefile-mjs-release-sync";
import {
	newQuickJSWASMModuleFromVariant,
	type QuickJSContext,
	type QuickJSHandle,
	type QuickJSWASMModule,
} from "quickjs-emscripten-core";
import type { OpDispatcher } from "./dispatcher.js";
import { resolveLimits, type SandboxLimits } from "./limits.js";
import { errorHandle, hostToHandle } from "./marshal.js";

/** One captured `console.*` line from inside the sandbox. */
export interface SandboxLogEntry {
	level: string;
	message: string;
}

/** The outcome of one `run_code` execution. Only JSON-serializable data crosses
 * back out — never a handle, the context, or anything host-side. */
export interface RunResult {
	ok: boolean;
	/** The value the script returned (present when `ok`). Possibly truncated. */
	result?: unknown;
	/** A model-actionable error message (present when not `ok`). */
	error?: string;
	logs: SandboxLogEntry[];
	/** Number of `turjuman.*` bridge calls the run made. */
	opsUsed: number;
	/** Whether the result was truncated to fit `maxOutputBytes`. */
	truncated: boolean;
	elapsedMs: number;
}

/** A self-contained sandbox eval: run `code` with the given host `dispatch` and
 * guest `stubSource`. The engine is transport-agnostic — it knows nothing about
 * `@turjuman/sdk`; the dispatcher and stubs carry that. */
export interface EvalRequest {
	code: string;
	dispatch: OpDispatcher;
	stubSource: string;
	limits?: Partial<SandboxLimits>;
}

// Errors that leave the QuickJS heap in a state where freeing the runtime would
// assert; on these we abandon the (per-run, throwaway) module and let GC reclaim
// it rather than risk an abort.
const DIRTY_RUNTIME = /out of memory|interrupted|stack overflow/i;

/**
 * Run untrusted `code` in a fresh QuickJS-WASM isolate whose only capability is
 * the host `dispatch` bridge (exposed to the guest as `turjuman.*` by
 * `stubSource`). The guest has no `fetch`/`process`/`require`/timers/`import` —
 * QuickJS provides none, and we add only the curated bridge + `console`. CPU
 * (wall-clock), memory, output size, and bridge-call count are all bounded.
 *
 * Each run gets its own WASM module instance so a script that times out or runs
 * the heap dirty can be abandoned (GC reclaims it) without disturbing any other
 * run — there is no shared interpreter state to corrupt.
 */
export async function evalInSandbox(req: EvalRequest): Promise<RunResult> {
	const limits = resolveLimits(req.limits);
	const startedAt = Date.now();
	const deadline = startedAt + limits.timeoutMs;
	const logs: SandboxLogEntry[] = [];
	// ops: bridge calls made; inflight: bridge dispatches not yet settled (the run
	// must not dispose the context while any are pending); logBytes: running total
	// of captured log bytes (bounded independently of the result).
	const counters = { ops: 0, inflight: 0, logBytes: 0 };

	// Singlefile variant: the WASM is embedded in the JS, so the engine bundles
	// self-contained (no separate .wasm asset to ship to Lambda).
	const mod: QuickJSWASMModule = await newQuickJSWASMModuleFromVariant(variant);
	const runtime = mod.newRuntime();
	runtime.setMemoryLimit(limits.memoryBytes);
	runtime.setInterruptHandler(() => Date.now() > deadline);
	const ctx = runtime.newContext();
	let disposable = false;

	try {
		installLog(ctx, logs, limits, counters);
		installBridge(ctx, req.dispatch, limits, counters);

		const boot = ctx.evalCode(req.stubSource);
		if (boot.error) {
			const message = readError(ctx, boot.error);
			return fail(
				`Sandbox bootstrap failed: ${message}`,
				logs,
				counters.ops,
				startedAt,
			);
		}
		boot.value.dispose();

		// Wrap user code in an async IIFE so it can `await` bridge calls and `return`
		// a value. Synchronous evaluation returns the (pending) result promise.
		const evalResult = ctx.evalCode(`(async () => {\n${req.code}\n})()`);
		if (evalResult.error) {
			return fail(
				readError(ctx, evalResult.error),
				logs,
				counters.ops,
				startedAt,
			);
		}

		const native = ctx.resolvePromise(evalResult.value);
		evalResult.value.dispose();

		let settled = false;
		void native.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);

		// Drive the run to quiescence: run pending jobs (resolving bridge promises and
		// microtasks), then yield so in-flight host dispatches can progress. The run is
		// done only when the script's promise has settled AND no bridge dispatch is
		// still in flight. Waiting for in-flight dispatches is essential: a guest that
		// fires `turjuman.*` without awaiting it would otherwise have its settlement
		// callback run `hostToHandle()` against an already-disposed context — a
		// use-after-free that hard-aborts the WASM runtime. On a deadline we return
		// WITHOUT disposing (disposable stays false), abandoning the throwaway module
		// to GC, since a still-pending dispatch may yet touch the context.
		while (!settled || counters.inflight > 0) {
			const jobs = runtime.executePendingJobs();
			if (jobs.error) {
				const message = readError(ctx, jobs.error);
				jobs.dispose();
				return fail(
					timeoutOr(deadline, message),
					logs,
					counters.ops,
					startedAt,
				);
			}
			jobs.dispose();
			if (settled && counters.inflight === 0) break;
			if (Date.now() > deadline) {
				return fail("Execution timed out", logs, counters.ops, startedAt);
			}
			await new Promise((resolve) => setImmediate(resolve));
		}

		// `native` is settled now; awaiting it is instant and yields a typed result.
		const result = await native;
		if (result.error) {
			const message = readError(ctx, result.error);
			// A normal rejection (e.g. NOT_FOUND) leaves the heap clean; an OOM/interrupt
			// does not — keep the runtime disposable only in the former case.
			disposable = !DIRTY_RUNTIME.test(message);
			return fail(timeoutOr(deadline, message), logs, counters.ops, startedAt);
		}

		const value = ctx.dump(result.value);
		result.value.dispose();
		disposable = true;
		const { value: out, truncated } = truncateOutput(
			value,
			limits.maxOutputBytes,
		);
		return {
			ok: true,
			result: out,
			logs,
			opsUsed: counters.ops,
			truncated,
			elapsedMs: Date.now() - startedAt,
		};
	} finally {
		// Dispose only when the heap is clean; otherwise abandon the throwaway module
		// (GC reclaims it) — never risk an abort that would surface as a hard crash.
		if (disposable) {
			try {
				ctx.dispose();
				runtime.dispose();
			} catch {
				// The module is per-run and now unreferenced; let GC reclaim it.
			}
		}
	}
}

/** Install `console.*` capture as a plain host function (`__log`). Bounded by both
 * entry count (`maxLogs`) and total bytes (`maxLogBytes`) — the latter so a guest
 * can't inflate the response past the output budget via many large log lines
 * (logs are returned to the model alongside the result). */
function installLog(
	ctx: QuickJSContext,
	logs: SandboxLogEntry[],
	limits: SandboxLimits,
	counters: { logBytes: number },
): void {
	const fn = ctx.newFunction("__log", (levelHandle, argsHandle) => {
		if (
			logs.length >= limits.maxLogs ||
			counters.logBytes >= limits.maxLogBytes
		)
			return;
		const level = ctx.getString(levelHandle);
		const args = argsHandle === undefined ? [] : ctx.dump(argsHandle);
		const parts = Array.isArray(args) ? args : [args];
		const message = parts
			.map((a) => (typeof a === "string" ? a : safeJson(a)))
			.join(" ");
		// Clamp each entry to 2000 chars, then to whatever byte budget remains, on a
		// UTF-8 boundary so a multibyte char is never split.
		const bounded = sliceUtf8(
			message.slice(0, 2000),
			limits.maxLogBytes - counters.logBytes,
		);
		counters.logBytes += Buffer.byteLength(bounded, "utf8");
		logs.push({ level, message: bounded });
	});
	ctx.setProp(ctx.global, "__log", fn);
	fn.dispose();
}

/** Install the `__callOp` host bridge. It returns a guest promise immediately and
 * resolves/rejects it when the host dispatch settles, so the guest can `await` a
 * `turjuman.*` call. Errors come back as real guest `Error`s; the bridge itself
 * never throws (that would be unrecoverable mid-suspension). */
function installBridge(
	ctx: QuickJSContext,
	dispatch: OpDispatcher,
	limits: SandboxLimits,
	counters: { ops: number; inflight: number },
): void {
	const fn = ctx.newFunction("__callOp", (nameHandle, argsHandle) => {
		const name = ctx.getString(nameHandle);
		const args = argsHandle === undefined ? {} : ctx.dump(argsHandle);
		const deferred = ctx.newPromise();

		const used = ++counters.ops;
		const work =
			used > limits.maxOps
				? Promise.reject(
						new Error(`Exceeded operation budget (${limits.maxOps} calls)`),
					)
				: Promise.resolve().then(() => dispatch(name, args));

		// Count this dispatch as in flight until its result is marshalled back into
		// the guest, so the settlement loop never disposes the context out from under
		// a pending callback (a use-after-free / WASM abort).
		counters.inflight += 1;
		void work
			.then(
				(result) => {
					const handle = hostToHandle(ctx, result);
					deferred.resolve(handle);
					handle.dispose();
				},
				(err: unknown) => {
					const handle = errorHandle(
						ctx,
						err instanceof Error ? err.message : String(err),
					);
					deferred.reject(handle);
					handle.dispose();
				},
			)
			.finally(() => {
				counters.inflight -= 1;
			});

		return deferred.handle;
	});
	ctx.setProp(ctx.global, "__callOp", fn);
	fn.dispose();
}

/** Read a guest error handle into a string message, disposing it. */
function readError(ctx: QuickJSContext, errorHandleRef: QuickJSHandle): string {
	const dumped = ctx.dump(errorHandleRef);
	errorHandleRef.dispose();
	if (typeof dumped === "string") return dumped;
	if (dumped && typeof dumped === "object" && "message" in dumped) {
		return String((dumped as { message: unknown }).message);
	}
	return safeJson(dumped);
}

/** Map an interrupt (deadline-exceeded) onto a stable "timed out" message. */
function timeoutOr(deadline: number, message: string): string {
	if (Date.now() > deadline || /interrupted/i.test(message))
		return "Execution timed out";
	return message;
}

function fail(
	error: string,
	logs: SandboxLogEntry[],
	opsUsed: number,
	startedAt: number,
): RunResult {
	return {
		ok: false,
		error,
		logs,
		opsUsed,
		truncated: false,
		elapsedMs: Date.now() - startedAt,
	};
}

/** Serialize the result and, if it exceeds the byte cap, replace it with a
 * truncated string note (so a huge return can't blow the model's context). The
 * cut is by BYTES, not UTF-16 code units, and lands on a UTF-8 boundary — and the
 * note is reserved within the budget, so the returned string never exceeds
 * `maxBytes`. */
function truncateOutput(
	value: unknown,
	maxBytes: number,
): { value: unknown; truncated: boolean } {
	const json = safeJson(value);
	const bytes = Buffer.byteLength(json, "utf8");
	if (bytes <= maxBytes) return { value, truncated: false };
	const note = `…[output truncated: ${bytes} bytes; cap ${maxBytes}]`;
	const noteBytes = Buffer.byteLength(note, "utf8");
	const kept = sliceUtf8(json, maxBytes - noteBytes);
	return { value: `${kept}${note}`, truncated: true };
}

/** Return the longest UTF-8 prefix of `s` that fits in `maxBytes`, never splitting
 * a multibyte character. Returns "" for a non-positive budget. */
function sliceUtf8(s: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const buf = Buffer.from(s, "utf8");
	if (buf.length <= maxBytes) return s;
	let cut = maxBytes;
	// If the cut lands inside a multibyte sequence (a continuation byte 0b10xxxxxx),
	// back up to the start of that sequence so it's dropped whole.
	while (cut > 0 && ((buf[cut] ?? 0) & 0xc0) === 0x80) cut--;
	return buf.toString("utf8", 0, cut);
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}
