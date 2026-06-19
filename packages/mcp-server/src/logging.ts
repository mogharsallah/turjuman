/**
 * Minimal structured logging for the Lambda path.
 *
 * One JSON object per line via plain `console` — no logging dependency. This is
 * the Lambda-idiomatic shape: CloudWatch ingests each line and CloudWatch Logs
 * Insights can query the fields directly (`filter outcome = "error"`, etc.).
 */

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
