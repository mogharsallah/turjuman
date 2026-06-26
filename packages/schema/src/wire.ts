/**
 * Wire schemas — the transport-facing shapes that cross the MCP/REST boundary.
 *
 * These build on the canonical entity schemas in `domain.ts` so there is one
 * definition per shape, shared by both transports:
 *   - MCP tools use them as `output` schemas (the SDK validates the emitted
 *     `structuredContent` against them).
 *   - The REST layer feeds them to `hono-openapi`'s `resolver` so the OpenAPI
 *     spec documents every response.
 *
 * Two kinds live here:
 *   1. **Public** entity schemas — an entity minus fields that must never leave
 *      the server (`ApiKey.hash`, `Webhook.secret`).
 *   2. **Aggregate / page / result** schemas — the multi-entity and summary
 *      shapes the services return. The service return types are derived from
 *      these (`z.infer`), so the types and the documented schemas can't drift.
 */

import "zod-openapi/extend";
import { z } from "zod";
import {
	apiKeySchema,
	translationKeySchema,
	translationSchema,
	webhookSchema,
} from "./domain.js";
import type { ErrorCode } from "./errors.js";
import { qaSeveritySchema } from "./validation.js";

// ---- public (sensitive-field-stripped) entity schemas -----------------------

/** An API key as listed/returned — never includes the secret's hash. */
export const apiKeyPublicSchema = apiKeySchema
	.omit({ hash: true })
	.openapi({ ref: "ApiKeyPublic" });
export type ApiKeyPublic = z.infer<typeof apiKeyPublicSchema>;

/** A webhook as listed/returned — never includes the signing secret. */
export const webhookPublicSchema = webhookSchema
	.omit({ secret: true })
	.openapi({ ref: "WebhookPublic" });
export type WebhookPublic = z.infer<typeof webhookPublicSchema>;

// ---- aggregate / page / result schemas --------------------------------------

/** A key plus all of its translations across locales (the `get_key` shape). */
export const keyWithTranslationsSchema = z
	.object({
		key: translationKeySchema,
		translations: z.array(translationSchema),
	})
	.openapi({ ref: "KeyWithTranslations" });
export type KeyWithTranslations = z.infer<typeof keyWithTranslationsSchema>;

/** One page of keys, plus an opaque cursor to fetch the next page (if any). */
export const keyPageSchema = z
	.object({
		keys: z.array(translationKeySchema),
		nextCursor: z
			.string()
			.optional()
			.describe("Opaque cursor; pass back as `cursor` for the next page."),
	})
	.openapi({ ref: "KeyPage" });
export type KeyPage = z.infer<typeof keyPageSchema>;

/** One page of a locale's translations, plus an opaque next-page cursor. */
export const translationPageSchema = z
	.object({
		translations: z.array(translationSchema),
		nextCursor: z
			.string()
			.optional()
			.describe("Opaque cursor; pass back as `cursor` for the next page."),
	})
	.openapi({ ref: "TranslationPage" });
export type TranslationPage = z.infer<typeof translationPageSchema>;

/** Adapter-ready export row: a translated value plus its key metadata. */
export const bundleEntrySchema = z
	.object({
		key: z.string(),
		namespace: z.string(),
		value: z.string(),
		description: z.string().optional(),
		plural: z.boolean(),
	})
	.openapi({ ref: "BundleEntry" });
export type BundleEntry = z.infer<typeof bundleEntrySchema>;

/** One page of export entries, plus an opaque next-page cursor. */
export const bundlePageSchema = z
	.object({
		entries: z.array(bundleEntrySchema),
		nextCursor: z
			.string()
			.optional()
			.describe("Opaque cursor; pass back as `cursor` for the next page."),
	})
	.openapi({ ref: "BundlePage" });
export type BundlePage = z.infer<typeof bundlePageSchema>;

/** Summary returned by a key import (CLI push of source keys). */
export const importKeysResultSchema = z
	.object({
		created: z.number().int(),
		updated: z.number().int(),
		reactivated: z.number().int(),
		baseValuesSet: z.number().int(),
		deleted: z.number().int(),
		deprecated: z.number().int(),
	})
	.openapi({ ref: "ImportKeysResult" });
export type ImportKeysResult = z.infer<typeof importKeysResultSchema>;

/** Summary returned by a bulk translation write: how many were written and which
 * keys were skipped (e.g. no such key in the project). */
export const bulkSetResultSchema = z
	.object({
		written: z.number().int(),
		skipped: z.array(z.string()),
	})
	.openapi({ ref: "BulkSetResult" });
export type BulkSetResult = z.infer<typeof bulkSetResultSchema>;

/** The one-time response of `create_api_key`: the key's public metadata plus the
 * full `secret`, which is shown exactly once and never stored or returned again. */
export const apiKeyCreatedSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		prefix: z
			.string()
			.describe(
				'Leading characters of the secret, for recognition (e.g. "op_live_ab12").',
			),
		readOnly: z
			.boolean()
			.describe("When true, the key may only perform read actions."),
		expiresAt: z
			.string()
			.optional()
			.describe("ISO-8601 expiry, if one was set."),
		secret: z
			.string()
			.describe("The full secret — shown ONCE here; store it securely."),
	})
	.openapi({ ref: "ApiKeyCreated" });
export type ApiKeyCreated = z.infer<typeof apiKeyCreatedSchema>;

/** Summary returned by a batch AI review: how many scores were written, which
 * keys were skipped (no such translation), and how the writes routed (how many
 * landed `approved` vs were flagged `needs_review`). */
export const reviewResultSchema = z
	.object({
		written: z.number().int(),
		skipped: z.array(z.string()),
		approved: z
			.number()
			.int()
			.describe("How many writes auto-promoted to approved."),
		flagged: z
			.number()
			.int()
			.describe("How many writes were flagged needs_review."),
	})
	.openapi({ ref: "ReviewResult" });
export type ReviewResult = z.infer<typeof reviewResultSchema>;

/** One message of an assembled scoring prompt (MCP prompt-message parity). */
export const scorePromptMessageSchema = z
	.object({
		role: z.enum(["user", "assistant"]),
		text: z.string(),
	})
	.openapi({ ref: "ScorePromptMessage" });
export type ScorePromptMessage = z.infer<typeof scorePromptMessageSchema>;

/** The assembled scoring prompt the server hands a reviewer agent: the rendered
 * messages (MQM rubric + project guidance + glossary + source/target) plus the
 * `promptVersion` to stamp back, and a `nextCursor` for the batch (review_locale)
 * form. Returned by both the MCP prompt and the REST score-prompt endpoint, so
 * the methodology can't drift between transports. */
export const scorePromptSchema = z
	.object({
		messages: z.array(scorePromptMessageSchema),
		promptVersion: z
			.string()
			.describe(
				"Version of the scoring methodology; stamp this when submitting the score.",
			),
		nextCursor: z
			.string()
			.optional()
			.describe(
				"Opaque cursor for the next page of the batch (review_locale) form.",
			),
	})
	.openapi({ ref: "ScorePrompt" });
export type ScorePrompt = z.infer<typeof scorePromptSchema>;

// ---- QA report --------------------------------------------------------------

/** A single QA problem found on one translation by one check. The canonical
 * shape behind core's `QaFinding`, MCP `run_qa_checks` output, and the REST
 * `POST /checks` response. */
export const qaFindingSchema = z
	.object({
		checkId: z.string(),
		severity: qaSeveritySchema,
		namespace: z.string(),
		keyName: z.string(),
		localeCode: z.string().describe("The target locale the finding is about."),
		message: z.string(),
		value: z
			.string()
			.optional()
			.describe("A short snippet of the offending value."),
	})
	.openapi({ ref: "QaFinding" });
export type QaFindingShape = z.infer<typeof qaFindingSchema>;

/** Error/warning/info rollup counts for a QA run. */
export const qaReportCountsSchema = z
	.object({
		error: z.number().int(),
		warning: z.number().int(),
		info: z.number().int(),
	})
	.openapi({ ref: "QaReportCounts" });
export type QaReportCountsShape = z.infer<typeof qaReportCountsSchema>;

/** The full result of a QA run: stable-sorted findings plus rollups, grouped by locale. */
export const qaReportSchema = z
	.object({
		projectId: z.string(),
		baseLocale: z.string(),
		locales: z.array(z.string()).describe("Locales actually checked."),
		checks: z
			.array(z.string())
			.describe("Check ids actually run (enabled ∩ requested)."),
		counts: qaReportCountsSchema,
		findings: z
			.array(qaFindingSchema)
			.describe("Stable-sorted by locale, namespace, keyName, checkId."),
		byLocale: z
			.record(z.string(), z.array(qaFindingSchema))
			.describe("The same findings grouped by target locale."),
	})
	.openapi({ ref: "QaReport" });
export type QaReportShape = z.infer<typeof qaReportSchema>;

// ---- shared error envelope --------------------------------------------------

/** The error code carried in every error response. Mirrors {@link ErrorCode}. */
export const errorCodeSchema = z.enum([
	"UNAUTHENTICATED",
	"FORBIDDEN",
	"NOT_FOUND",
	"CONFLICT",
	"VALIDATION",
	"INTERNAL",
]);
// Compile-time guard: keep `errorCodeSchema` and the `ErrorCode` union in lockstep.
type _ErrorCodeParity = [
	z.infer<typeof errorCodeSchema> extends ErrorCode ? true : never,
	ErrorCode extends z.infer<typeof errorCodeSchema> ? true : never,
];

/** The body every transport returns on error: a message, a typed code, and the
 * per-request correlation id. Documented once and reused across error responses. */
export const errorEnvelopeSchema = z
	.object({
		error: z.string().describe("Human-readable error message."),
		code: errorCodeSchema,
		requestId: z
			.string()
			.describe(
				"Per-request correlation id, echoed in the X-Request-Id header.",
			),
	})
	.openapi({ ref: "ErrorEnvelope" });
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
