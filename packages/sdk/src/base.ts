import {
	type Actor,
	apiKeyCreatedSchema,
	bulkSetResultSchema,
	emailSchema,
	globalRoleSchema,
	glossaryTermSchema,
	keyPageSchema,
	keyWithTranslationsSchema,
	localeCodeSchema,
	localeSchema,
	membershipSchema,
	namespaceSchema,
	projectRoleSchema,
	projectSchema,
	qaConfigSchema,
	qaReportSchema,
	qaSeveritySchema,
	reviewResultSchema,
	scoreConfigSchema,
	scoreValueSchema,
	settableStatusSchema,
	type TurjumanService,
	translationKeySchema,
	translationSchema,
	translationStatusSchema,
	type User,
	userSchema,
	webhookSchema,
} from "@turjuman/core";
import { z } from "zod";

/** Re-exported so each operation group imports everything it needs from this one
 * module. Output schemas come straight from core (the canonical entity/wire
 * schemas), so the structured result shapes every transport emits can't drift
 * from what the services return. Enum/field schemas (roles, status, severity,
 * locale/namespace) are likewise re-exported from core rather than redefined, so
 * an operation's input validation can't drift from the entity definitions
 * either. */
export {
	apiKeyCreatedSchema,
	bulkSetResultSchema,
	emailSchema,
	globalRoleSchema as globalRole,
	glossaryTermSchema,
	keyPageSchema,
	keyWithTranslationsSchema,
	localeCodeSchema,
	localeSchema,
	membershipSchema,
	namespaceSchema,
	// The role field helpers used by admin operations are core's canonical enums.
	projectRoleSchema as projectRole,
	projectSchema,
	qaConfigSchema,
	qaReportSchema,
	qaSeveritySchema,
	reviewResultSchema,
	scoreConfigSchema,
	scoreValueSchema,
	settableStatusSchema,
	translationKeySchema,
	translationSchema,
	translationStatusSchema,
	userSchema,
	webhookSchema,
	z,
};

/**
 * Behaviour hints for an operation (read-only / destructive / idempotent), kept
 * **MCP-protocol-free** on purpose: this package is the transport-agnostic source
 * of capability, so it must not depend on `@modelcontextprotocol/sdk`. The shape
 * is a structural superset-compatible subset of MCP's `ToolAnnotations`, so the
 * MCP projection can pass these straight through (see mcp-server's
 * `annotationsFor`).
 */
export interface OpAnnotations {
	title?: string;
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
}

/** Everything an operation handler needs: the service and the authenticated
 * caller. The single execution context shared by every transport (MCP tool call,
 * REST route, code-mode sandbox bridge). */
export interface OpContext {
	service: TurjumanService;
	actor: Actor;
	user: User;
	/** Per-request correlation id, surfaced to the client on a masked error. */
	requestId: string;
}

/**
 * How an operation projects onto an HTTP route. Optional: an operation with no
 * `http` binding is reachable over MCP (and the sandbox) but not yet exposed as a
 * REST endpoint — the coverage tracker lists exactly those (see
 * `operationsMissingHttp`).
 *
 * MCP/SDK inputs are flat objects that mix path/query fields (e.g. `projectId`,
 * `locale`) with body fields. `params` names the fields that map onto the URL
 * (path segments matched by `:name`, or query params otherwise); the remaining
 * fields form the JSON request body. This split is what lets the REST projection
 * document a correct request `$ref` distinct from the flat tool input.
 */
export interface HttpBinding {
	method: "get" | "post" | "put" | "patch" | "delete";
	/** Route path with `:name` placeholders, e.g. "/v1/projects/:id/locales". */
	path: string;
	/** Map of URL path-param name → operation input field (e.g. `{ id: "projectId" }`).
	 * The remaining input fields form the JSON request body (write methods). */
	params?: Record<string, string>;
}

/**
 * Operation-naming verb convention — keep names disambiguated so a model
 * selecting between near-synonyms picks the right one (names are a public
 * contract; sharpen descriptions rather than renaming):
 *   create — make a new top-level entity (create_project, create_key)
 *   add    — attach a child to an existing parent (add_locale, add_member)
 *   set    — write a value, creating or replacing it (set_translation)
 *   update — patch an entity's metadata fields (update_key, update_project)
 *   delete — hard, cascading removal (delete_key, delete_project)
 *   remove — detach a child / mute, without deleting the parent (remove_member)
 */

/** Storage shape: the handler arg type is erased so operations of different
 * schemas can live in one array. {@link op} preserves authoring-time type
 * safety. */
export interface Operation {
	name: string;
	description: string;
	input: z.ZodTypeAny;
	/** Optional object schema for the operation's structured result. When present,
	 * transports validate the emitted structured content against it. */
	output?: z.ZodTypeAny;
	/** Behaviour hints. When omitted, the transport derives them from the name. */
	annotations?: OpAnnotations;
	/** Optional REST projection (method/path/param split). Absent ⇒ MCP-only. */
	http?: HttpBinding;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	handler: (args: any, ctx: OpContext) => Promise<unknown>;
}

export function op<S extends z.ZodTypeAny>(def: {
	name: string;
	description: string;
	input: S;
	output?: z.ZodTypeAny;
	annotations?: OpAnnotations;
	http?: HttpBinding;
	handler: (args: z.infer<S>, ctx: OpContext) => Promise<unknown>;
}): Operation {
	return def as Operation;
}

// ---- shared field schemas used across operation groups ----------------------
// `projectRole`/`globalRole` are re-exported from core above (its canonical
// `projectRoleSchema`/`globalRoleSchema`) — not redefined here.

export const projectId = z.string().describe("Project id, e.g. proj_xxx");
// Reuse the shared field schemas (core's validation) so every boundary validates
// locale/namespace/email exactly as the service does.
export const namespace = namespaceSchema
	.optional()
	.describe('Key namespace (logical group). Defaults to "default".');
export const localeCode = localeCodeSchema.describe(
	'Locale code, e.g. "fr" or "es-MX"',
);

// Shared pagination inputs and the locale-scoped key-list output, used by the
// paged growth/queue operations across groups (translations + scoring). Defined
// once here so the page wording and list shape can't drift between files.
export const pageLimit = z
	.number()
	.int()
	.positive()
	.max(200)
	.optional()
	.describe("Page size (default 100, max 200)");
export const pageCursor = z
	.string()
	.optional()
	.describe("nextCursor from a previous page");

/** The keys plus the locale and a page count, so a client gets context without a
 * second call. `count` is this page's size; `nextCursor` (when present) fetches
 * the next page. */
export const localeKeyList = z.object({
	locale: z.string(),
	count: z.number().int(),
	keys: z.array(translationKeySchema),
	nextCursor: z.string().optional(),
});

// Output schemas for structured content are the canonical core schemas
// (`translationKeySchema`, `translationSchema`, `keyWithTranslationsSchema`,
// `bulkSetResultSchema`), re-exported above — no hand-maintained mirror here.
