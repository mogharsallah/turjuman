import { maskError } from "@turjuman/core";
import { OPERATIONS_BY_NAME, type OpContext } from "@turjuman/sdk";

/**
 * The host broker: turns a bridge call `(name, args)` from inside the sandbox
 * into an in-process call to the matching operation's handler, run with the
 * request's authenticated {@link OpContext}. This is the *only* capability the
 * guest has — and it is the same handler a normal MCP tool call or REST route
 * runs, so RBAC in core is enforced identically.
 */
export type OpDispatcher = (name: string, args: unknown) => Promise<unknown>;

/**
 * Build an in-process dispatcher bound to one authenticated context. Args are
 * validated against the operation's input schema (so a bad call fails exactly as
 * it would over MCP), and errors are masked at the boundary with the same policy
 * as the MCP tool callback: an {@link AppError} surfaces its code + message (the
 * model can act on it, even if its code catches the error), while any other fault
 * is logged server-side and replaced with a correlation-id reference — so nothing
 * internal can leak into guest-visible code.
 */
export function createOpDispatcher(ctx: OpContext): OpDispatcher {
  return async (name, args) => {
    const op = OPERATIONS_BY_NAME.get(name);
    if (!op) throw new Error(`Unknown operation: ${name}`);
    let parsed: unknown;
    try {
      parsed = op.input.parse(args ?? {});
    } catch (e) {
      // Schema validation failure is model-actionable: surface it plainly.
      const message = e instanceof Error ? e.message : String(e);
      throw new Error(`VALIDATION: ${name}: ${message}`);
    }
    try {
      return await op.handler(parsed, ctx);
    } catch (e) {
      // Same masking policy as every other transport boundary (see core's
      // `maskError`): an AppError surfaces its code + message; anything else is
      // logged server-side and replaced with a correlation-id reference.
      const masked = maskError(e, { msg: "sandbox_op_error", requestId: ctx.requestId, operation: name });
      throw new Error(masked.isAppError ? `${masked.code}: ${masked.message}` : masked.message);
    }
  };
}
