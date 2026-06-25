import variant from "@jitl/quickjs-singlefile-mjs-release-sync";
import {
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSWASMModule,
  newQuickJSWASMModuleFromVariant,
} from "quickjs-emscripten-core";
import type { OpDispatcher } from "./dispatcher.js";
import { type SandboxLimits, resolveLimits } from "./limits.js";
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
  const counters = { ops: 0 };

  // Singlefile variant: the WASM is embedded in the JS, so the engine bundles
  // self-contained (no separate .wasm asset to ship to Lambda).
  const mod: QuickJSWASMModule = await newQuickJSWASMModuleFromVariant(variant);
  const runtime = mod.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const ctx = runtime.newContext();
  let disposable = false;

  try {
    installLog(ctx, logs, limits);
    installBridge(ctx, req.dispatch, limits, counters);

    const boot = ctx.evalCode(req.stubSource);
    if (boot.error) {
      const message = readError(ctx, boot.error);
      return fail(`Sandbox bootstrap failed: ${message}`, logs, counters.ops, startedAt);
    }
    boot.value.dispose();

    // Wrap user code in an async IIFE so it can `await` bridge calls and `return`
    // a value. Synchronous evaluation returns the (pending) result promise.
    const evalResult = ctx.evalCode(`(async () => {\n${req.code}\n})()`);
    if (evalResult.error) {
      return fail(readError(ctx, evalResult.error), logs, counters.ops, startedAt);
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

    // Drive the guest to settlement: run pending jobs (resolving bridge promises
    // and microtasks), then yield so in-flight host dispatches can progress.
    while (!settled) {
      const jobs = runtime.executePendingJobs();
      if (jobs.error) {
        const message = readError(ctx, jobs.error);
        jobs.dispose();
        return fail(timeoutOr(deadline, message), logs, counters.ops, startedAt);
      }
      jobs.dispose();
      if (settled) break;
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
    const { value: out, truncated } = truncateOutput(value, limits.maxOutputBytes);
    return { ok: true, result: out, logs, opsUsed: counters.ops, truncated, elapsedMs: Date.now() - startedAt };
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

/** Install `console.*` capture as a plain host function (`__log`). */
function installLog(ctx: QuickJSContext, logs: SandboxLogEntry[], limits: SandboxLimits): void {
  const fn = ctx.newFunction("__log", (levelHandle, argsHandle) => {
    if (logs.length >= limits.maxLogs) return;
    const level = ctx.getString(levelHandle);
    const args = argsHandle === undefined ? [] : ctx.dump(argsHandle);
    const parts = Array.isArray(args) ? args : [args];
    const message = parts.map((a) => (typeof a === "string" ? a : safeJson(a))).join(" ");
    logs.push({ level, message: message.slice(0, 2000) });
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
  counters: { ops: number },
): void {
  const fn = ctx.newFunction("__callOp", (nameHandle, argsHandle) => {
    const name = ctx.getString(nameHandle);
    const args = argsHandle === undefined ? {} : ctx.dump(argsHandle);
    const deferred = ctx.newPromise();

    const used = ++counters.ops;
    const work =
      used > limits.maxOps
        ? Promise.reject(new Error(`Exceeded operation budget (${limits.maxOps} calls)`))
        : Promise.resolve().then(() => dispatch(name, args));

    void work.then(
      (result) => {
        const handle = hostToHandle(ctx, result);
        deferred.resolve(handle);
        handle.dispose();
      },
      (err: unknown) => {
        const handle = errorHandle(ctx, err instanceof Error ? err.message : String(err));
        deferred.reject(handle);
        handle.dispose();
      },
    );

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
  if (Date.now() > deadline || /interrupted/i.test(message)) return "Execution timed out";
  return message;
}

function fail(error: string, logs: SandboxLogEntry[], opsUsed: number, startedAt: number): RunResult {
  return { ok: false, error, logs, opsUsed, truncated: false, elapsedMs: Date.now() - startedAt };
}

/** Serialize the result and, if it exceeds the byte cap, replace it with a
 * truncated string note (so a huge return can't blow the model's context). */
function truncateOutput(value: unknown, maxBytes: number): { value: unknown; truncated: boolean } {
  const json = safeJson(value);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes <= maxBytes) return { value, truncated: false };
  return { value: `${json.slice(0, maxBytes)}…[output truncated: ${bytes} bytes; cap ${maxBytes}]`, truncated: true };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
