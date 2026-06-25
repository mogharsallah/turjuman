/**
 * Minimal structured logging shared by every Lambda transport (MCP, REST API,
 * webhook dispatcher).
 *
 * One JSON object per line via plain `console` — no logging dependency. This is
 * the Lambda-idiomatic shape: CloudWatch ingests each line and CloudWatch Logs
 * Insights can query the fields directly (`filter outcome = "error"`, etc.). All
 * three functions emit the same field vocabulary (`msg`, `requestId`, `keyId`,
 * `status`, `ms`, …) so a single Insights query spans the whole stack.
 */

import { AppError, type ErrorCode } from "@turjuman/schema";

/** Emit one structured info line (per-request summaries). */
export function logInfo(fields: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ level: "info", ...stripUndefined(fields) }));
}

/** Emit one structured error line (unexpected throws, masked tool errors). */
export function logError(fields: Record<string, unknown>): void {
  console.error(JSON.stringify({ level: "error", ...stripUndefined(fields) }));
}

/**
 * The safe, server-side-only shape of a thrown value. Captures the stack for the
 * operator's logs; callers never put this on the wire (clients get a generic
 * message + correlation id instead).
 */
export function errorInfo(e: unknown): { name: string; message: string; stack?: string } {
  if (e instanceof Error) return { name: e.name, message: e.message, stack: e.stack };
  return { name: "NonError", message: String(e) };
}

/** Drop undefined fields so optional keys (e.g. `tool`) don't clutter the line. */
function stripUndefined(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

/** The classified, safe-to-surface form of a thrown value. */
export interface MaskedError {
  /** True when the error is an intentional {@link AppError} whose code + message
   * are safe to return to the client/model. */
  isAppError: boolean;
  /** The AppError's code, or `"INTERNAL"` for a masked fault. */
  code: ErrorCode;
  /** The AppError's message, or a correlation-id reference for a masked fault. */
  message: string;
}

/**
 * The single error-masking policy shared by every transport boundary — the MCP
 * tool/prompt callbacks, the code-mode sandbox dispatcher, and the REST `onError`
 * handler. An {@link AppError} is an intentional, model/client-actionable failure
 * (bad input, a permission denial), so its code + message are safe to surface.
 * Anything else is an unexpected fault: it is logged server-side (with
 * `logFields`, e.g. the operation/tool name) and replaced with a generic message
 * plus the request id, so nothing internal can leak into client/model context.
 * Each caller formats the {@link MaskedError} for its own wire shape — having one
 * classification + logging policy keeps the boundaries from drifting apart.
 */
export function maskError(
  e: unknown,
  logFields: { msg: string; requestId: string } & Record<string, unknown>,
): MaskedError {
  if (e instanceof AppError) return { isAppError: true, code: e.code, message: e.message };
  logError({ ...logFields, error: errorInfo(e) });
  return { isAppError: false, code: "INTERNAL", message: `Internal error (ref: ${logFields.requestId})` };
}
