import type { OpAnnotations, Operation } from "./base.js";
import { OPERATIONS } from "./operations/index.js";

/**
 * Operation introspection: behaviour-hint derivation + the REST coverage
 * tracker. These transport-agnostic classification primitives are what the MCP
 * projection (`effectiveAnnotations`/`isReadOnly`) and the knowledge layer build
 * on. Free-text search over operations + docs (and the typed-signature rendering)
 * now lives in `@turjuman/knowledge`, so this file no longer owns a search.
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

/** Operations that are not yet projected onto an HTTP route (no `http` binding) —
 * the live "still missing vs MCP" coverage list (see the API coverage tracker).
 * Every operation is reachable over MCP and the sandbox; this names the gap in
 * the REST surface. */
export function operationsMissingHttp(): string[] {
	return OPERATIONS.filter((o) => !o.http).map((o) => o.name);
}
