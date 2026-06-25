import { type OpAnnotations, type Operation, z } from "./base.js";
import { GROUP_BY_OPERATION, OPERATIONS } from "./operations/index.js";

/**
 * Operation introspection helpers: deriving behaviour hints, summarising an
 * operation's signature, and searching the registry. These are the
 * transport-agnostic primitives the MCP `search_sdk` tool and the code-mode stub
 * codegen build on (a richer, zod-to-ts signature lives in `@turjuman/sandbox`).
 */

/** Derive an operation's effective behaviour hints. An explicit `op.annotations`
 * wins; otherwise derive from the verb in the name — read ops are read-only, the
 * delete/revoke/remove family is destructive, and the rest are non-destructive
 * writes (set_/update_ are also idempotent). This classification is a property of
 * the operation, not of any transport, so it lives here; the MCP projection maps
 * the result onto MCP's `ToolAnnotations` unchanged. */
export function effectiveAnnotations(op: Operation): OpAnnotations {
  if (op.annotations) return op.annotations;
  const name = op.name;
  if (/^(list|get|search|lookup)_/.test(name)) return { readOnlyHint: true };
  if (/^(delete|revoke|remove)_/.test(name)) {
    return { readOnlyHint: false, destructiveHint: true };
  }
  return {
    readOnlyHint: false,
    destructiveHint: false,
    ...(/^(set|update)_/.test(name) ? { idempotentHint: true } : {}),
  };
}

/** Whether an operation only reads (its effective `readOnlyHint`). */
export function isReadOnly(op: Operation): boolean {
  return effectiveAnnotations(op).readOnlyHint === true;
}

/** The top-level input field names of an operation (empty for a non-object input). */
export function inputFieldNames(schema: z.ZodTypeAny): string[] {
  return schema instanceof z.ZodObject
    ? Object.keys(schema.shape as Record<string, unknown>)
    : [];
}

/** A compact, model-facing summary of one operation — enough for `search_sdk` to
 * present without the full JSON Schema. */
export interface OperationSummary {
  name: string;
  group: string;
  description: string;
  readOnly: boolean;
  destructive: boolean;
  /** Top-level input field names (the arg keys the caller passes). */
  inputFields: string[];
}

export function summarizeOperation(op: Operation): OperationSummary {
  const ann = effectiveAnnotations(op);
  return {
    name: op.name,
    group: GROUP_BY_OPERATION.get(op.name) ?? "other",
    description: op.description,
    readOnly: ann.readOnlyHint === true,
    destructive: ann.destructiveHint === true,
    inputFields: inputFieldNames(op.input),
  };
}

/** Score how well an operation matches the query terms: name hits weigh most,
 * then group, then description. Zero means no match. */
function scoreMatch(s: OperationSummary, terms: string[]): number {
  const name = s.name.toLowerCase();
  const group = s.group.toLowerCase();
  const description = s.description.toLowerCase();
  let score = 0;
  for (const t of terms) {
    if (name.includes(t)) score += 3;
    if (group.includes(t)) score += 2;
    if (description.includes(t)) score += 1;
  }
  return score;
}

/** Search the operation registry by free-text query (matched against name,
 * group, and description). An empty query returns the whole registry (capped at
 * `limit`), so a model can list everything. Results are ordered best-match first.
 */
export function searchOperations(query: string, limit = 20): OperationSummary[] {
  const all = OPERATIONS.map(summarizeOperation);
  const q = query.trim().toLowerCase();
  if (!q) return all.slice(0, limit);
  const terms = q.split(/\s+/).filter(Boolean);
  return all
    .map((s) => ({ s, score: scoreMatch(s, terms) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.s);
}

/** Operations that are not yet projected onto an HTTP route (no `http` binding) —
 * the live "still missing vs MCP" coverage list (see the API coverage tracker).
 * Every operation is reachable over MCP and the sandbox; this names the gap in
 * the REST surface. */
export function operationsMissingHttp(): string[] {
  return OPERATIONS.filter((o) => !o.http).map((o) => o.name);
}
