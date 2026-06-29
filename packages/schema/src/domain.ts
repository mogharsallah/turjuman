/**
 * Turjuman domain model.
 *
 * Each entity is defined **once** as a zod schema; its TypeScript type is derived
 * via `z.infer`. These schemas are the canonical representation of every entity in
 * the platform — storage-agnostic (the DynamoDB repository maps them to/from
 * single-table items) and shared by services, MCP tools, and REST handlers.
 *
 * Defining the model as zod (rather than bare interfaces) makes it the single
 * source of truth for **outputs** the same way `validation.ts` is for inputs: the
 * transport-facing response schemas in `wire.ts` build on these, so the MCP
 * `structuredContent` schemas and the OpenAPI response schemas can never drift
 * from the types the services actually return.
 *
 * Field formats reuse the shared schemas from `validation.ts` (locale/namespace/
 * key-name/email), so a value that validates on the way in also matches on the
 * way out.
 */

import "zod-openapi/extend";
import { z } from "zod";
import {
	emailSchema,
	keyNameSchema,
	localeCodeSchema,
	namespaceSchema,
	qaSeveritySchema,
} from "./validation.js";

/**
 * Entity schemas that surface in REST responses carry an `.openapi({ ref })` so
 * `hono-openapi` emits them once under `components.schemas` and `$ref`s them
 * everywhere they appear — standalone or nested in a `wire.ts` aggregate. The
 * metadata is inert for MCP (its JSON-Schema converter ignores it) and for
 * `z.infer`/`.parse()`.
 */

// ---- enums (shared by entity, wire, and transport input schemas) ------------

/** Organisation-wide role. Controls user management and cross-project authority. */
export const globalRoleSchema = z.enum(["OWNER", "ADMIN", "MEMBER"]);
export type GlobalRole = z.infer<typeof globalRoleSchema>;

/** Role a user holds on a single project. A user may hold different roles per project. */
export const projectRoleSchema = z.enum([
	"MANAGER",
	"EDITOR",
	"DEVELOPER",
	"VIEWER",
]);
export type ProjectRole = z.infer<typeof projectRoleSchema>;

/**
 * Lifecycle of a translation cell — the **entire** review verdict (no score).
 * `untranslated` (no value yet) → `proposed` (a draft value awaiting acceptance)
 * → `accepted` (the agent self-accepted, or a human flipped it). `escalated`
 * routes an irreducible judgment to a human; `retired` soft-deletes a cell whose
 * key was retired.
 */
export const cellLifecycleSchema = z.enum([
	"untranslated",
	"proposed",
	"accepted",
	"escalated",
	"retired",
]);
export type CellLifecycle = z.infer<typeof cellLifecycleSchema>;

/** How a translation value was produced (provenance). A merge keeps the
 * transported value's original origin, so there is no `merge` origin: `human` (a
 * person typed it), `agent` (the model decided it), `import` (a CLI/REST push). */
export const translationOriginSchema = z.enum(["human", "agent", "import"]);
export type TranslationOrigin = z.infer<typeof translationOriginSchema>;

/** Soft-delete lifecycle of a structural entity (key / locale / namespace):
 * present and usable, or retained-but-hidden so `Scope` coordinates never dangle. */
export const keyStateSchema = z.enum(["active", "deprecated"]);
export type KeyState = z.infer<typeof keyStateSchema>;

/** Severity of a QA finding, and the level at which a QA check is configured. */
export type QaSeverity = z.infer<typeof qaSeveritySchema>;

/** Events a webhook can subscribe to. `*` matches all. */
export const webhookEventSchema = z.enum([
	"translation.updated",
	/** A key's base value changed — its translations may now be stale (re-translate). */
	"translation.stale",
	"key.created",
	"key.updated",
	"key.deleted",
	"locale.added",
	/** A translation run (the agent write primitive) started / finished. */
	"run.started",
	"run.finished",
]);
export type WebhookEvent = z.infer<typeof webhookEventSchema>;

// ---- entity schemas ---------------------------------------------------------

export const userSchema = z
	.object({
		id: z.string(),
		orgId: z.string(),
		email: emailSchema,
		name: z.string(),
		globalRole: globalRoleSchema,
		createdAt: z.string(),
		updatedAt: z.string(),
	})
	.openapi({ ref: "User" });
export type User = z.infer<typeof userSchema>;

export const apiKeySchema = z.object({
	/** Public identifier, safe to display/list. */
	id: z.string().describe("Public identifier, safe to display/list."),
	orgId: z.string(),
	userId: z.string(),
	name: z.string(),
	/** sha256 of the full secret. The secret itself is never stored. */
	hash: z
		.string()
		.describe("sha256 of the full secret. The secret itself is never stored."),
	/** Leading characters of the secret, shown for recognition (e.g. "op_live_ab12"). */
	prefix: z
		.string()
		.describe(
			'Leading characters of the secret, shown for recognition (e.g. "op_live_ab12").',
		),
	createdAt: z.string(),
	lastUsedAt: z.string().optional(),
	/** Optional expiry (ISO-8601). Past this instant the key no longer authenticates. */
	expiresAt: z
		.string()
		.optional()
		.describe(
			"Optional expiry (ISO-8601). Past this instant the key no longer authenticates.",
		),
	/** When true, the key may only perform read actions, regardless of the user's role. */
	readOnly: z
		.boolean()
		.optional()
		.describe(
			"When true, the key may only perform read actions, regardless of the user's role.",
		),
});
export type ApiKey = z.infer<typeof apiKeySchema>;

export const projectSchema = z
	.object({
		id: z.string(),
		orgId: z.string(),
		name: z.string(),
		slug: z.string(),
		description: z.string().optional(),
		/** Source locale every key is authored in, e.g. "en". */
		baseLocale: localeCodeSchema.describe(
			'Source locale every key is authored in, e.g. "en".',
		),
		/** Monotonic counter bumped on any scoped context write; drives context-staleness. */
		contextRevision: z
			.number()
			.int()
			.describe(
				"Monotonic counter bumped on any scoped context write (context-staleness).",
			),
		/** When true, the agent's run can only leave cells `proposed`; a human must
		 * flip `proposed → accepted` (a run-attributed accept is rejected). */
		requireHumanAccept: z
			.boolean()
			.describe(
				"When true, only a human (not a run) may accept a proposed translation.",
			),
		createdAt: z.string(),
		updatedAt: z.string(),
	})
	.openapi({ ref: "Project" });
export type Project = z.infer<typeof projectSchema>;

export const localeSchema = z
	.object({
		projectId: z.string(),
		/** BCP-47-ish code, e.g. "fr", "es-MX", "pt-BR". */
		code: localeCodeSchema.describe(
			'BCP-47-ish code, e.g. "fr", "es-MX", "pt-BR".',
		),
		name: z.string().optional(),
		/** Soft-delete state; a deprecated locale's cells are retained but hidden. */
		lifecycle: keyStateSchema,
		createdAt: z.string(),
	})
	.openapi({ ref: "Locale" });
export type Locale = z.infer<typeof localeSchema>;

/**
 * A namespace: an optional grouping of keys by feature-area (file / screen /
 * feature). An opaque-`id` entity whose `name` is a renamable display label. It
 * becomes the "voice" context tier in a later batch; here it is the identity
 * carrier so keys reference `namespaceId`, never a name.
 */
export const namespaceEntitySchema = z
	.object({
		id: z.string(),
		projectId: z.string(),
		/** Display label (file / feature), unique per project. */
		name: namespaceSchema.describe(
			"Display label (file/feature), unique per project.",
		),
		title: z.string().optional(),
		description: z.string().optional(),
		lifecycle: keyStateSchema,
		createdAt: z.string(),
		updatedAt: z.string(),
	})
	.openapi({ ref: "Namespace" });
export type Namespace = z.infer<typeof namespaceEntitySchema>;

/** Where a key surfaces in the UI — briefing data only, never a `Scope`.
 * **Deferred:** typed here as the target shape but not populated or consumed. */
export const placementSchema = z.object({
	surface: z.string(),
	screen: z.string(),
	role: z.string(),
	order: z.number().int().optional(),
});
export type Placement = z.infer<typeof placementSchema>;

export const translationKeySchema = z
	.object({
		/** Opaque identity; `(namespaceId, name)` are renamable labels, not identity. */
		id: z.string().describe("Opaque key identity (stable across renames)."),
		projectId: z.string(),
		/** Optional namespace grouping (FK to a Namespace entity); absent = no namespace. */
		namespaceId: z
			.string()
			.optional()
			.describe("Namespace grouping (FK); absent = no namespace."),
		name: keyNameSchema,
		/** Context for translators and the connected LLM. */
		description: z
			.string()
			.optional()
			.describe("Context for translators and the connected LLM."),
		/** When true, values are ICU plural messages. */
		plural: z.boolean().describe("When true, values are ICU plural messages."),
		maxLength: z.number().int().optional(),
		tags: z.array(z.string()),
		/** "active" when present in the latest source import; "deprecated" when absent but retained. */
		state: keyStateSchema.describe(
			'"active" when present in the latest source import; "deprecated" when absent but retained.',
		),
		/** Keep the whole key verbatim across locales (brand names, codes). */
		noTranslate: z
			.boolean()
			.optional()
			.describe(
				"Keep the whole key verbatim across locales (brand names, codes).",
			),
		/** Content hash + timestamp of the base value; bumps on a base edit and fires the forward loop. */
		sourceRevision: z
			.string()
			.describe(
				"Revision token of the base value; bumps on a base edit and stales dependents.",
			),
		/** Branch this key was introduced on (provenance + merge hint). */
		introducedOnBranchId: z.string().optional(),
		/** UI placements — briefing data only. **Deferred**: typed, not yet populated. */
		placements: z.array(placementSchema).optional(),
		/** ISO timestamp of the last import that created, updated, or reactivated this key. */
		lastSeenAt: z
			.string()
			.optional()
			.describe(
				"ISO timestamp of the last import that created, updated, or reactivated this key.",
			),
		createdAt: z.string(),
		updatedAt: z.string(),
	})
	.openapi({ ref: "TranslationKey" });
export type TranslationKey = z.infer<typeof translationKeySchema>;

/** Lifecycle of a branch (its own state, distinct from shippability). */
export const branchStatusSchema = z.enum(["open", "merged", "abandoned"]);
export type BranchStatus = z.infer<typeof branchStatusSchema>;

/**
 * A named, copy-on-write line of work over a project's keys and translations.
 * `main` always exists (`parentBranchId = null`) and is the safe root; nothing
 * experimental touches it until a deliberate merge. Branching is optional —
 * most self-host users only ever work on `main`.
 */
export const branchSchema = z
	.object({
		id: z.string(),
		projectId: z.string(),
		name: z.string(),
		/** Parent branch; `null` for `main`. */
		parentBranchId: z.string().nullable(),
		/** The parent's state at fork time — the merge baseline. Absent for `main`. */
		forkPoint: z.string().optional(),
		status: branchStatusSchema,
		createdBy: z.string(),
		createdAt: z.string(),
		mergedAt: z.string().optional(),
	})
	.openapi({ ref: "Branch" });
export type Branch = z.infer<typeof branchSchema>;

/**
 * The living translation cell, one per `(branchId, keyId, locale)`. Copy-on-
 * write: a cell exists only on the branch that wrote it; an unwritten cell
 * resolves by falling through to the parent branch. The lifecycle is the entire
 * review verdict — there is no score.
 */
export const translationSchema = z
	.object({
		projectId: z.string(),
		branchId: z.string(),
		keyId: z.string(),
		locale: localeCodeSchema,
		/** ICU MessageFormat string — the working draft (the only mutable text). */
		value: z
			.string()
			.describe("ICU MessageFormat string (plain string for simple values)."),
		/** Pointer (version seq) to the current accepted TranslationVersion — the
		 * cell's branch-head. Doubles as the accept compare-and-swap + merge token.
		 * Absent until the first accept. */
		head: z
			.number()
			.int()
			.optional()
			.describe(
				"Seq of the current accepted version (the branch-head / CAS token).",
			),
		lifecycle: cellLifecycleSchema,
		/** Derived: `sourceRef != key.sourceRevision`. */
		stale: z.boolean(),
		/** The base revision this cell was translated from (captured at loop start). */
		sourceRef: z
			.string()
			.optional()
			.describe(
				"The base revision this value was written against; derives staleness.",
			),
		/** How the current `value` was produced. Absent when unknown. */
		origin: translationOriginSchema
			.optional()
			.describe("How the current `value` was produced. Absent when unknown."),
		/** Set while a run or escalation owns the cell (in-flight exclusivity). */
		lockedByRunId: z.string().optional(),
		/** userId of the last editor. */
		updatedBy: z.string().describe("userId of the last editor."),
		updatedAt: z.string(),
	})
	.openapi({ ref: "Translation" });
export type Translation = z.infer<typeof translationSchema>;

/**
 * An accepted-value commit: append-only, one chain per `(branchId, keyId,
 * locale)`. The cell's `head` points at the current one; accepted text lives
 * here, not in a mutable field, which is what makes "accepted" non-destructive.
 */
export const translationVersionSchema = z
	.object({
		projectId: z.string(),
		branchId: z.string(),
		keyId: z.string(),
		locale: localeCodeSchema,
		/** Monotonic position in the chain (zero-padded in storage for SK ordering). */
		seq: z.number().int(),
		value: z.string(),
		origin: translationOriginSchema.optional(),
		acceptedAt: z.string(),
		/** Human who accepted (absent when a run accepted). */
		acceptedBy: z.string().optional(),
		/** Run that accepted (absent when a human accepted). */
		runRef: z.string().optional(),
		/** The key's base revision at accept time. */
		sourceRevision: z.string().optional(),
		/** Previous version's seq, linking the chain (absent for the first). */
		prevVersionRef: z.number().int().optional(),
		/** Set when a later revert supersedes this version. */
		supersededBy: z.number().int().optional(),
	})
	.openapi({ ref: "TranslationVersion" });
export type TranslationVersion = z.infer<typeof translationVersionSchema>;

/** What triggered a run. A `merge` transports already-accepted values from a
 * sibling branch instead of generating them. */
export const runTriggerSchema = z.enum([
	"key.created",
	"context-change",
	"field-report",
	"manual",
	"merge",
]);
export type RunTrigger = z.infer<typeof runTriggerSchema>;

/** Run progress state. */
export const runStatusSchema = z.enum([
	"queued",
	"running",
	"partial",
	"done",
	"failed",
	"canceled",
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

/**
 * The controlled write primitive: one job that applies a set of value-changes
 * onto one branch, recording what the external MCP-driven agent did. A merge is
 * just a run with `trigger=merge`. Draft writes (CLI import) do NOT need a run;
 * only the accept transition is funnelled through one.
 */
export const translationRunSchema = z
	.object({
		id: z.string(),
		projectId: z.string(),
		branchId: z.string(),
		trigger: runTriggerSchema,
		/** `agent` (generated) or `branch:<id>` (a merge transporting accepted values). */
		valueSource: z.string(),
		status: runStatusSchema,
		/** Dedupe token for at-least-once webhook delivery. */
		idempotencyKey: z.string().optional(),
		/** Output tokens / cost recorded for the run (recorded, not enforced). */
		budgetSpent: z.number().optional(),
		cellsTotal: z.number().int(),
		cellsDone: z.number().int(),
		errors: z.array(z.string()),
		startedAt: z.string(),
		finishedAt: z.string().optional(),
	})
	.openapi({ ref: "TranslationRun" });
export type TranslationRun = z.infer<typeof translationRunSchema>;

export const membershipSchema = z
	.object({
		projectId: z.string(),
		userId: z.string(),
		role: projectRoleSchema,
		createdAt: z.string(),
	})
	.openapi({ ref: "Membership" });
export type Membership = z.infer<typeof membershipSchema>;

export const glossaryTermSchema = z
	.object({
		projectId: z.string(),
		id: z.string(),
		/** The source term (authored in the project's base locale). */
		term: z
			.string()
			.describe("The source term (authored in the project's base locale)."),
		/** Preferred translation per locale, e.g. `{ fr: "panier" }`. */
		translations: z
			.record(z.string(), z.string())
			.describe('Preferred translation per locale, e.g. `{ fr: "panier" }`.'),
		/** Match the term case-sensitively when surfacing it to translators. */
		caseSensitive: z
			.boolean()
			.describe(
				"Match the term case-sensitively when surfacing it to translators.",
			),
		/** Keep verbatim across locales (brand names, product names). */
		doNotTranslate: z
			.boolean()
			.describe("Keep verbatim across locales (brand names, product names)."),
		notes: z.string().optional(),
		createdAt: z.string(),
		updatedAt: z.string(),
	})
	.openapi({ ref: "GlossaryTerm" });
export type GlossaryTerm = z.infer<typeof glossaryTermSchema>;

export const webhookSchema = z
	.object({
		projectId: z.string(),
		id: z.string(),
		url: z.string(),
		/** Subscribed events, or `["*"]` for all. */
		events: z
			.array(z.union([webhookEventSchema, z.literal("*")]))
			.describe('Subscribed events, or `["*"]` for all.'),
		/** Shared secret used to HMAC-sign delivery payloads. */
		secret: z
			.string()
			.describe("Shared secret used to HMAC-sign delivery payloads."),
		createdAt: z.string(),
	})
	.openapi({ ref: "Webhook" });
export type Webhook = z.infer<typeof webhookSchema>;

/** A rule that mutes QA findings matching every field it specifies. */
export const qaIgnoreRuleSchema = z.object({
	checkId: z.string().optional(),
	namespace: z.string().optional(),
	keyName: z.string().optional(),
	locale: z.string().optional(),
});
export type QaIgnoreRule = z.infer<typeof qaIgnoreRuleSchema>;

/**
 * Per-project QA configuration: a singleton record holding per-check overrides
 * (enable/disable, severity) and ignore rules. Checks absent from `checks` use
 * their built-in defaults. Absence of the whole record means "all defaults".
 */
export const qaConfigSchema = z
	.object({
		projectId: z.string(),
		/** Per-check overrides keyed by check id. */
		checks: z
			.record(
				z.string(),
				z.object({
					enabled: z.boolean().optional(),
					severity: qaSeveritySchema.optional(),
				}),
			)
			.describe("Per-check overrides keyed by check id."),
		/** Findings matching any of these rules are dropped from the report. */
		ignore: z
			.array(qaIgnoreRuleSchema)
			.describe(
				"Findings matching any of these rules are dropped from the report.",
			),
		updatedBy: z.string(),
		updatedAt: z.string(),
	})
	.openapi({ ref: "QaConfig" });
export type QaConfig = z.infer<typeof qaConfigSchema>;

/** Default namespace label applied when an import does not specify one. */
export const DEFAULT_NAMESPACE = "default";

/** The reserved id + name of the always-present root branch. */
export const MAIN_BRANCH_ID = "main";
