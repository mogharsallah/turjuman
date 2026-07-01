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

// ---- context-layer enums + the scope grid-coordinate ------------------------

/** Lifecycle of a context entity (rule / glossary term / example). The resolver
 * collects only `active` cells; `proposed`/`retired`/`archived` are ignored. */
export const contextLifecycleSchema = z.enum([
	"proposed",
	"active",
	"retired",
	"archived",
]);
export type ContextLifecycle = z.infer<typeof contextLifecycleSchema>;

/** How a context rule folds across the cascade tiers — a property of the rule's
 * *kind*, not its tier: `override` (narrowest wins), `union` (collect all tiers),
 * `restrict` (most-restrictive AND — a parent rule a child cannot loosen). */
export const contextOperatorSchema = z.enum(["override", "union", "restrict"]);
export type ContextOperator = z.infer<typeof contextOperatorSchema>;

/** The kind of a context rule; selects its payload shape and default operator. */
export const contextRuleKindSchema = z.enum([
	"voice",
	"length",
	"placeholdersRequired",
	"format",
	"compliance",
]);
export type ContextRuleKind = z.infer<typeof contextRuleKindSchema>;

/** Quality tier of a translation example, used for retrieval ranking. */
export const exampleQualitySchema = z.enum(["gold", "accepted"]);
export type ExampleQuality = z.infer<typeof exampleQualitySchema>;

/** Whether a human escalation is still open or has been resolved. */
export const escalationStatusSchema = z.enum(["open", "resolved"]);
export type EscalationStatus = z.infer<typeof escalationStatusSchema>;

/** Lifecycle of a Release (the immutable shipped snapshot): `open` is live,
 * `superseded` was replaced by a newer release on the same branch, `frozen` is
 * retained read-only. */
export const releaseStatusSchema = z.enum(["open", "frozen", "superseded"]);
export type ReleaseStatus = z.infer<typeof releaseStatusSchema>;

/** Whether a production field report is still open or has been resolved. */
export const fieldReportStatusSchema = z.enum(["open", "resolved"]);
export type FieldReportStatus = z.infer<typeof fieldReportStatusSchema>;

/**
 * The grid coordinate a context entity lives at. Tier is the narrowest populated
 * of `{ keyId, namespaceId, projectId }`; `locale` is orthogonal (absent = the
 * all-locales cell). One value object lets any context entity sit at any cell.
 */
export const scopeSchema = z
	.object({
		projectId: z.string(),
		namespaceId: z.string().optional(),
		keyId: z.string().optional(),
		locale: localeCodeSchema.optional(),
	})
	.openapi({ ref: "Scope" });
export type Scope = z.infer<typeof scopeSchema>;

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
	/** A translation was escalated to a human, claimed, or resolved. */
	"escalation.opened",
	"escalation.claimed",
	"escalation.resolved",
	/** Production reported a shipped string wrong (field report opened / resolved). */
	"field-report.opened",
	"field-report.resolved",
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

/** One pinned cell in a Release: the accepted version of a `(keyId, locale)` at
 * cut time. `versionRef` is the TranslationVersion `seq` on the pinned branch. */
export const releaseEntrySchema = z.object({
	keyId: z.string(),
	locale: localeCodeSchema,
	versionRef: z.number().int(),
});
export type ReleaseEntry = z.infer<typeof releaseEntrySchema>;

/**
 * An immutable shipped snapshot — what is live. **Pins one branch** and
 * materializes its resolved accepted view (own cells + fall-through) at a moment
 * in time. "Live" is the latest Release, never a per-cell flag, so a reopened
 * cell or re-export never silently changes what shipped. Anchors rollback,
 * reproducible CI export, and field reports.
 */
export const releaseSchema = z
	.object({
		id: z.string(),
		projectId: z.string(),
		/** The branch this release pinned. */
		branchId: z.string(),
		label: z.string(),
		/** Locales included in the snapshot. */
		locales: z.array(localeCodeSchema),
		status: releaseStatusSchema,
		createdBy: z.string(),
		createdAt: z.string(),
		/** The pinned accepted versions, one per `(keyId, locale)` cell. */
		entries: z.array(releaseEntrySchema),
	})
	.openapi({ ref: "Release" });
export type Release = z.infer<typeof releaseSchema>;

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
		/** Cascade coordinate; absent = project-wide. Glossary merges by union. */
		scope: scopeSchema
			.optional()
			.describe("Cascade coordinate; absent = project-wide."),
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
		/** Context lifecycle; only `active` terms are surfaced by the resolver. */
		lifecycle: contextLifecycleSchema.default("active"),
		createdAt: z.string(),
		updatedAt: z.string(),
	})
	.openapi({ ref: "GlossaryTerm" });
export type GlossaryTerm = z.infer<typeof glossaryTermSchema>;

/**
 * The parametric carrier for every scoped, mergeable translation rule. One entity
 * because rules differ only by `kind` + `operator` + `payload` shape — the
 * operator is *data*, not a class. `voice` overrides (narrowest tier wins);
 * `length`/`format`/`placeholdersRequired` override (or restrict when `hard`);
 * `compliance` restricts (a parent rule a child cannot loosen).
 */
export const contextRuleSchema = z
	.object({
		id: z.string(),
		projectId: z.string(),
		scope: scopeSchema,
		kind: contextRuleKindSchema,
		operator: contextOperatorSchema,
		/** Kind-specific payload (voice `{ tone, formality }`, length `{ max }`, …). */
		payload: z
			.record(z.string(), z.unknown())
			.describe("Kind-specific payload (voice/length/compliance fields)."),
		/** A hard rule a child scope cannot loosen (folds as `restrict`). */
		hard: z.boolean().optional(),
		lifecycle: contextLifecycleSchema.default("active"),
		createdBy: z.string(),
		createdAt: z.string(),
		updatedAt: z.string(),
	})
	.openapi({ ref: "ContextRule" });
export type ContextRule = z.infer<typeof contextRuleSchema>;

/**
 * A source→target translation example: the few-shot / translation-memory corpus.
 * Retrieved deterministically by scope-proximity + quality + recency (no
 * embeddings, per the project constraints). Merges by union across the cascade.
 */
export const exampleSchema = z
	.object({
		id: z.string(),
		projectId: z.string(),
		scope: scopeSchema,
		/** Target locale the `targetText` is written in. */
		locale: localeCodeSchema,
		sourceText: z.string(),
		targetText: z.string(),
		quality: exampleQualitySchema,
		origin: translationOriginSchema.optional(),
		lifecycle: contextLifecycleSchema.default("active"),
		createdAt: z.string(),
		updatedAt: z.string(),
	})
	.openapi({ ref: "Example" });
export type Example = z.infer<typeof exampleSchema>;

/**
 * A threaded discussion attached to a `(keyId, locale)` string — shared across
 * branches (it targets the string, not one branch's cell). Where humans record
 * the judgment a lifecycle flag can't carry; confirmed threads graduate into
 * shared Examples/GlossaryTerms.
 */
export const commentSchema = z
	.object({
		id: z.string(),
		projectId: z.string(),
		keyId: z.string(),
		locale: localeCodeSchema,
		authorId: z.string(),
		body: z.string(),
		/** Parent comment id for threading; absent = a root comment. */
		parentId: z.string().optional(),
		createdAt: z.string(),
	})
	.openapi({ ref: "Comment" });
export type Comment = z.infer<typeof commentSchema>;

/**
 * The human terminal exit of the review router: a cell the agent could not
 * resolve. Slim by design — the cell's lifecycle is the entire verdict. Claiming
 * is a compare-and-swap on `claimedBy`; resolving sets the cell value, accepts,
 * and may spawn an Example/GlossaryTerm so a human decision becomes reusable
 * context rather than a dead-end approval.
 */
export const escalationSchema = z
	.object({
		id: z.string(),
		projectId: z.string(),
		branchId: z.string(),
		keyId: z.string(),
		locale: localeCodeSchema,
		reason: z.string(),
		/** Defaults to a project MANAGER when the opener does not assign one. */
		assigneeUserId: z.string().optional(),
		claimedBy: z.string().optional(),
		claimedAt: z.string().optional(),
		status: escalationStatusSchema,
		openedAt: z.string(),
		resolvedAt: z.string().optional(),
		/** What the resolution did: the value chosen + any spawned context. */
		resolution: z
			.object({
				valueChosen: z.string().optional(),
				spawnedExampleRef: z.string().optional(),
				spawnedGlossaryRef: z.string().optional(),
			})
			.optional(),
	})
	.openapi({ ref: "Escalation" });
export type Escalation = z.infer<typeof escalationSchema>;

/**
 * Production feedback: "this shipped string is wrong" — the one fact the in-loop
 * agent provably cannot know from its own context. Filing **reopens the targeted
 * cell** (`accepted → proposed`, re-entering the router); `releaseRef` names the
 * release that was live. Resolving may **spawn an Example/GlossaryTerm** so a
 * correction compounds into reusable context. Slim by design — no corroboration
 * math, no trust fold: an API-key-gated tool has no anonymous mob to guard against.
 */
export const fieldReportSchema = z
	.object({
		id: z.string(),
		projectId: z.string(),
		/** Branch whose cell is reopened for the fix (default `main`). */
		branchId: z.string(),
		keyId: z.string(),
		locale: localeCodeSchema,
		/** The Release that was live when the bad string shipped (provenance). */
		releaseRef: z.string().optional(),
		description: z.string(),
		status: fieldReportStatusSchema,
		reportedBy: z.string(),
		createdAt: z.string(),
		resolvedAt: z.string().optional(),
		/** What the resolution spawned, if anything. */
		resolution: z
			.object({
				spawnedExampleRef: z.string().optional(),
				spawnedGlossaryRef: z.string().optional(),
			})
			.optional(),
	})
	.openapi({ ref: "FieldReport" });
export type FieldReport = z.infer<typeof fieldReportSchema>;

// ---- cascade resolution outputs (computed, never stored) --------------------

/** The cascade tier a resolved value came from (provenance), scope-major /
 * locale-minor — the override precedence ladder, highest first. */
export const cascadeTierSchema = z.enum([
	"key×locale",
	"key×all",
	"namespace×locale",
	"namespace×all",
	"project×locale",
	"project×all",
]);
export type CascadeTier = z.infer<typeof cascadeTierSchema>;

/** One provenance entry: which field resolved from which tier, and whether a
 * narrower tier overrode a broader one (a deliberate exception → raises review). */
export const provenanceEntrySchema = z.object({
	field: z.string(),
	tier: cascadeTierSchema,
	crossTierOverride: z.boolean().optional(),
});
export type ProvenanceEntry = z.infer<typeof provenanceEntrySchema>;

/** Deterministic locale shaping derived from the locale code (not authored). */
export const localeShapeSchema = z.object({
	locale: localeCodeSchema,
	pluralCategories: z.array(z.string()),
	rtl: z.boolean(),
});
export type LocaleShape = z.infer<typeof localeShapeSchema>;

/** The resolved context bundle for one `key × locale`: the folded cascade plus
 * provenance, orphan warnings, and the review-depth signal. */
export const resolvedContextSchema = z
	.object({
		scope: scopeSchema,
		/** Resolved voice (override — narrowest populated tier wins). */
		voice: z.record(z.string(), z.unknown()).optional(),
		/** Effective override + restrict constraints (length / format / compliance). */
		constraints: z.array(contextRuleSchema),
		/** Glossary terms in scope (union). */
		glossary: z.array(glossaryTermSchema),
		/** Retrieved examples (union, ranked). */
		examples: z.array(exampleSchema),
		provenance: z.array(provenanceEntrySchema),
		/** Scopes a context cell pointed at but that no longer resolve. */
		orphanedContext: z.array(scopeSchema),
		/** Locale shaping (plural categories, RTL) derived from the locale. */
		shape: localeShapeSchema,
		/** `raised` when a cross-tier override or a restrict conflict was seen. */
		reviewDepth: z.enum(["normal", "raised"]),
		/** Unresolved `restrict` conflicts (a structural escalation signal). */
		conflicts: z.array(z.string()),
	})
	.openapi({ ref: "ResolvedContext" });
export type ResolvedContext = z.infer<typeof resolvedContextSchema>;

/** The agent briefing for one `key × locale`: the key, its base value, and the
 * resolved context cascade — the single thing the agent needs to translate well. */
export const briefSchema = z
	.object({
		key: translationKeySchema,
		locale: localeCodeSchema,
		baseValue: z.string().optional(),
		context: resolvedContextSchema,
	})
	.openapi({ ref: "Brief" });
export type Brief = z.infer<typeof briefSchema>;

/** The outcome of merging a branch into its parent: the merge run, how many cells
 * transported cleanly, and any conflicts raised as escalations for a human. */
export const mergeResultSchema = z
	.object({
		run: translationRunSchema,
		/** Cells transported cleanly onto the parent. */
		merged: z.number().int(),
		/** Merge conflicts surfaced as escalations (parent advanced past forkPoint). */
		conflicts: z.array(escalationSchema),
	})
	.openapi({ ref: "MergeResult" });
export type MergeResult = z.infer<typeof mergeResultSchema>;

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
