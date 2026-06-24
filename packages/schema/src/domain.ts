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
  scoreValueSchema,
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
export const projectRoleSchema = z.enum(["MANAGER", "EDITOR", "DEVELOPER", "VIEWER"]);
export type ProjectRole = z.infer<typeof projectRoleSchema>;

/**
 * Lifecycle of a single translation value. `needs_review` is the AI-scoring
 * landing state: a value graded below the project's threshold (or manually
 * flagged) that carries a value but is held back from approval for a human.
 */
export const translationStatusSchema = z.enum([
  "untranslated",
  "translated",
  "needs_review",
  "approved",
]);
export type TranslationStatus = z.infer<typeof translationStatusSchema>;

/** How a translation value was produced (provenance). */
export const translationOriginSchema = z.enum(["human", "llm", "tm", "mt", "import"]);
export type TranslationOrigin = z.infer<typeof translationOriginSchema>;

/** Source lifecycle of a key: present in the latest import, or absent but retained. */
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
]);
export type WebhookEvent = z.infer<typeof webhookEventSchema>;

// ---- entity schemas ---------------------------------------------------------

export const userSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  email: emailSchema,
  name: z.string(),
  globalRole: globalRoleSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
}).openapi({ ref: "User" });
export type User = z.infer<typeof userSchema>;

export const apiKeySchema = z.object({
  /** Public identifier, safe to display/list. */
  id: z.string().describe("Public identifier, safe to display/list."),
  orgId: z.string(),
  userId: z.string(),
  name: z.string(),
  /** sha256 of the full secret. The secret itself is never stored. */
  hash: z.string().describe("sha256 of the full secret. The secret itself is never stored."),
  /** Leading characters of the secret, shown for recognition (e.g. "op_live_ab12"). */
  prefix: z.string().describe('Leading characters of the secret, shown for recognition (e.g. "op_live_ab12").'),
  createdAt: z.string(),
  lastUsedAt: z.string().optional(),
  /** Optional expiry (ISO-8601). Past this instant the key no longer authenticates. */
  expiresAt: z.string().optional().describe("Optional expiry (ISO-8601). Past this instant the key no longer authenticates."),
  /** When true, the key may only perform read actions, regardless of the user's role. */
  readOnly: z.boolean().optional().describe("When true, the key may only perform read actions, regardless of the user's role."),
});
export type ApiKey = z.infer<typeof apiKeySchema>;

export const projectSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().optional(),
  /** Source locale every key is authored in, e.g. "en". */
  baseLocale: localeCodeSchema.describe('Source locale every key is authored in, e.g. "en".'),
  createdAt: z.string(),
  updatedAt: z.string(),
}).openapi({ ref: "Project" });
export type Project = z.infer<typeof projectSchema>;

export const localeSchema = z.object({
  projectId: z.string(),
  /** BCP-47-ish code, e.g. "fr", "es-MX", "pt-BR". */
  code: localeCodeSchema.describe('BCP-47-ish code, e.g. "fr", "es-MX", "pt-BR".'),
  name: z.string().optional(),
  createdAt: z.string(),
}).openapi({ ref: "Locale" });
export type Locale = z.infer<typeof localeSchema>;

export const translationKeySchema = z.object({
  projectId: z.string(),
  /** Logical grouping (file/feature). Defaults to "default". */
  namespace: namespaceSchema.describe('Logical grouping (file/feature). Defaults to "default".'),
  name: keyNameSchema,
  /** Context for translators and the connected LLM. */
  description: z.string().optional().describe("Context for translators and the connected LLM."),
  /** When true, values are ICU plural messages. */
  plural: z.boolean().describe("When true, values are ICU plural messages."),
  maxLength: z.number().int().optional(),
  tags: z.array(z.string()),
  /** "active" when present in the latest source import; "deprecated" when absent but retained. */
  state: keyStateSchema.describe('"active" when present in the latest source import; "deprecated" when absent but retained.'),
  /** ISO timestamp of the last import that created, updated, or reactivated this key. */
  lastSeenAt: z.string().optional().describe("ISO timestamp of the last import that created, updated, or reactivated this key."),
  createdAt: z.string(),
  updatedAt: z.string(),
}).openapi({ ref: "TranslationKey" });
export type TranslationKey = z.infer<typeof translationKeySchema>;

export const translationSchema = z.object({
  projectId: z.string(),
  localeCode: localeCodeSchema,
  namespace: namespaceSchema,
  keyName: keyNameSchema,
  /** ICU MessageFormat string (plain string for simple values). */
  value: z.string().describe("ICU MessageFormat string (plain string for simple values)."),
  status: translationStatusSchema,
  /** Last approved value — the snapshot delivery ships. Set only on approval (status → "approved"). */
  approvedValue: z.string().optional().describe('Last approved value — the snapshot delivery ships. Set only on approval (status → "approved").'),
  /** The base value this working `value` was written against; used to derive staleness. */
  sourceRef: z.string().optional().describe("The base value this working `value` was written against; used to derive staleness."),
  /** How the current `value` was produced. Absent when unknown. */
  origin: translationOriginSchema.optional().describe("How the current `value` was produced. Absent when unknown."),
  /** Latest AI quality score (0–100) for the working `value`; absent until scored. A re-score overwrites it. */
  score: scoreValueSchema.optional().describe("Latest AI quality score (0–100) for the working value; absent until scored."),
  /** The reviewer model's one- or two-sentence rationale for the latest `score`. */
  scoreComment: z.string().optional().describe("The reviewer model's rationale for the latest score."),
  /** userId of the key that submitted the latest score. */
  scoredBy: z.string().optional().describe("userId of the key that submitted the latest score."),
  /** ISO timestamp of the latest score. */
  scoredAt: z.string().optional().describe("ISO timestamp of the latest score."),
  /** Identifier of the model that produced the latest score (provenance). */
  scoreModel: z.string().optional().describe("Identifier of the model that produced the latest score (provenance)."),
  /** Version of the scoring methodology/prompt the latest score was produced under. */
  promptVersion: z.string().optional().describe("Version of the scoring methodology/prompt the latest score was produced under."),
  /** userId of the last editor. */
  updatedBy: z.string().describe("userId of the last editor."),
  updatedAt: z.string(),
}).openapi({ ref: "Translation" });
export type Translation = z.infer<typeof translationSchema>;

export const membershipSchema = z.object({
  projectId: z.string(),
  userId: z.string(),
  role: projectRoleSchema,
  createdAt: z.string(),
}).openapi({ ref: "Membership" });
export type Membership = z.infer<typeof membershipSchema>;

export const glossaryTermSchema = z.object({
  projectId: z.string(),
  id: z.string(),
  /** The source term (authored in the project's base locale). */
  term: z.string().describe("The source term (authored in the project's base locale)."),
  /** Preferred translation per locale, e.g. `{ fr: "panier" }`. */
  translations: z.record(z.string(), z.string()).describe('Preferred translation per locale, e.g. `{ fr: "panier" }`.'),
  /** Match the term case-sensitively when surfacing it to translators. */
  caseSensitive: z.boolean().describe("Match the term case-sensitively when surfacing it to translators."),
  /** Keep verbatim across locales (brand names, product names). */
  doNotTranslate: z.boolean().describe("Keep verbatim across locales (brand names, product names)."),
  notes: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).openapi({ ref: "GlossaryTerm" });
export type GlossaryTerm = z.infer<typeof glossaryTermSchema>;

export const webhookSchema = z.object({
  projectId: z.string(),
  id: z.string(),
  url: z.string(),
  /** Subscribed events, or `["*"]` for all. */
  events: z.array(z.union([webhookEventSchema, z.literal("*")])).describe('Subscribed events, or `["*"]` for all.'),
  /** Shared secret used to HMAC-sign delivery payloads. */
  secret: z.string().describe("Shared secret used to HMAC-sign delivery payloads."),
  createdAt: z.string(),
}).openapi({ ref: "Webhook" });
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
export const qaConfigSchema = z.object({
  projectId: z.string(),
  /** Per-check overrides keyed by check id. */
  checks: z
    .record(z.string(), z.object({ enabled: z.boolean().optional(), severity: qaSeveritySchema.optional() }))
    .describe("Per-check overrides keyed by check id."),
  /** Findings matching any of these rules are dropped from the report. */
  ignore: z.array(qaIgnoreRuleSchema).describe("Findings matching any of these rules are dropped from the report."),
  updatedBy: z.string(),
  updatedAt: z.string(),
}).openapi({ ref: "QaConfig" });
export type QaConfig = z.infer<typeof qaConfigSchema>;

/**
 * Per-project AI-scoring configuration: a singleton record holding the
 * auto-approve `threshold`, the `autoApprove` opt-in (off by default), and
 * optional evaluation `guidance` merged into the scoring prompt. Absence of the
 * whole record means "defaults" (threshold 90, auto-approve off).
 */
export const scoreConfigSchema = z.object({
  projectId: z.string(),
  /** Minimum score (0–100) a translation must reach to be eligible for auto-approve. */
  threshold: scoreValueSchema.describe("Minimum score (0–100) to be eligible for auto-approve."),
  /** When true, a high score on machine-origin work auto-promotes it to `approved`. */
  autoApprove: z.boolean().describe("When true, a high score on machine-origin work auto-promotes it to approved."),
  /** Optional per-project evaluation guidance, merged into the scoring prompt. */
  guidance: z.string().optional().describe("Per-project evaluation guidance, merged into the scoring prompt."),
  updatedBy: z.string(),
  updatedAt: z.string(),
}).openapi({ ref: "ScoreConfig" });
export type ScoreConfig = z.infer<typeof scoreConfigSchema>;

/** Default namespace applied when a key does not specify one. */
export const DEFAULT_NAMESPACE = "default";
