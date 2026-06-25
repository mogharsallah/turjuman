import type { QuickJSContext, QuickJSHandle } from "quickjs-emscripten";

/**
 * Marshal a host JS value into a QuickJS guest handle. Operation results are
 * plain JSON-serializable domain objects, so we round-trip through a JSON literal
 * parsed inside the guest — correct for every JSON value and disposal-trivial
 * (one handle), with no risk of executing host code (the source is pure JSON, a
 * subset of JS literals). `undefined` and non-serializable values become the
 * guest `undefined`.
 */
export function hostToHandle(ctx: QuickJSContext, value: unknown): QuickJSHandle {
  const json = value === undefined ? undefined : JSON.stringify(value);
  if (json === undefined) return ctx.undefined;
  return ctx.unwrapResult(ctx.evalCode(`(${json})`));
}

/** Build a guest `Error` handle carrying `message`, so a rejected bridge call is
 * a real `Error` the guest can `catch` and read `.message` from. */
export function errorHandle(ctx: QuickJSContext, message: string): QuickJSHandle {
  return ctx.unwrapResult(ctx.evalCode(`new Error(${JSON.stringify(message)})`));
}
