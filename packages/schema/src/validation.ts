import "zod-openapi/extend";
import { z } from "zod";
import { validation } from "./errors.js";

/**
 * Shared validation rules — the single source of truth for Turjuman's field
 * formats. Both the service layer (the imperative `requireX` helpers, which
 * throw `AppError`) and the transport layers (the zod field/body schemas, used
 * to validate MCP tool arguments and REST request bodies) build on the **same**
 * regexes, so a value accepted at one surface is accepted at the others.
 */

export const LOCALE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
export const KEY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const NAMESPACE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// ---- zod field schemas (transport input validation) -------------------------

/** A locale/BCP-47-ish code, e.g. "en" or "es-MX". Trimmed. */
export const localeCodeSchema = z
	.string()
	.trim()
	.regex(LOCALE_RE, 'Must be a locale code like "en" or "es-MX"');

/** A translation key name. Trimmed. */
export const keyNameSchema = z
	.string()
	.trim()
	.regex(KEY_NAME_RE, "Invalid key name");

/** A key namespace (logical group). Trimmed. */
export const namespaceSchema = z
	.string()
	.trim()
	.regex(NAMESPACE_RE, "Invalid namespace");

/** An email address. Trimmed and lower-cased. */
export const emailSchema = z
	.string()
	.trim()
	.toLowerCase()
	.regex(EMAIL_RE, "Invalid email");

/** Non-empty free text (trimmed). */
export const nonEmptyTextSchema = z.string().trim().min(1);

/** A settable translation status (the "untranslated" lifecycle state can't be set directly). */
export const settableStatusSchema = z.enum(["translated", "approved"]);

// ---- request body schemas (REST; reused by the MCP/Hono transports) ---------

/** Body of `POST /v1/projects/:id/locales`. */
export const addLocaleBodySchema = z
	.object({
		code: localeCodeSchema,
		name: z.string().optional(),
	})
	.openapi({ ref: "AddLocaleBody" });

/** Body of `POST /v1/projects/:id/keys/import` (the CLI `push` of source keys). */
export const importKeysBodySchema = z
	.object({
		namespace: namespaceSchema.optional(),
		prune: z.boolean().optional(),
		/** Soft-deprecate keys absent from this batch (namespace-authoritative push). */
		deprecate: z.boolean().optional(),
		entries: z.array(
			z.object({
				// Names are re-validated by the service (createKey/importKeys) so its exact
				// VALIDATION message is preserved; here we only require the field's presence.
				name: z.string(),
				description: z.string().optional(),
				baseValue: z.string().optional(),
				plural: z.boolean().optional(),
			}),
		),
	})
	.openapi({ ref: "ImportKeysBody" });

/** Body of `POST /v1/projects/:id/translations/import` (the CLI `push` of values). */
export const importTranslationsBodySchema = z
	.object({
		locale: localeCodeSchema,
		entries: z.array(
			z.object({
				name: z.string(),
				namespace: namespaceSchema.optional(),
				value: z.string(),
				status: settableStatusSchema.optional(),
			}),
		),
	})
	.openapi({ ref: "ImportTranslationsBody" });

/** A QA finding/check severity. */
export const qaSeveritySchema = z.enum(["error", "warning", "info"]);

/** Body of `POST /v1/projects/:id/checks` (run QA checks). */
export const runChecksBodySchema = z
	.object({
		locale: localeCodeSchema.optional(),
		checks: z.array(z.string()).optional(),
		slot: z.enum(["working", "approved"]).optional(),
	})
	.openapi({ ref: "RunChecksBody" });

/** An MQM quality score: an integer 0–100. */
export const scoreValueSchema = z.number().int().min(0).max(100);

/** Body of `POST /v1/projects/:id/translations/score` (submit one AI score). */
export const scoreTranslationBodySchema = z
	.object({
		locale: localeCodeSchema,
		name: z.string(),
		namespace: namespaceSchema.optional(),
		score: scoreValueSchema,
		comment: z.string().optional(),
		/** Identifier of the model that produced the score (provenance). */
		model: z.string().optional(),
	})
	.openapi({ ref: "ScoreTranslationBody" });

/** Body of `POST /v1/projects/:id/translations/review` (submit many AI scores). */
export const reviewTranslationsBodySchema = z
	.object({
		locale: localeCodeSchema,
		entries: z
			.array(
				z.object({
					name: z.string(),
					namespace: namespaceSchema.optional(),
					score: scoreValueSchema,
					comment: z.string().optional(),
					model: z.string().optional(),
				}),
			)
			.min(1)
			.max(500),
	})
	.openapi({ ref: "ReviewTranslationsBody" });

/** Body of `PUT /v1/projects/:id/score-config` (per-project AI-scoring configuration). */
export const scoreConfigBodySchema = z
	.object({
		threshold: scoreValueSchema.optional(),
		autoApprove: z.boolean().optional(),
		guidance: z.string().optional(),
	})
	.openapi({ ref: "ScoreConfigBody" });

/** Body of `PUT /v1/projects/:id/qa-config` (per-project QA configuration). */
export const qaConfigBodySchema = z
	.object({
		checks: z
			.record(
				z.string(),
				z.object({
					enabled: z.boolean().optional(),
					severity: qaSeveritySchema.optional(),
				}),
			)
			.optional(),
		ignore: z
			.array(
				z.object({
					checkId: z.string().optional(),
					namespace: namespaceSchema.optional(),
					keyName: z.string().optional(),
					locale: localeCodeSchema.optional(),
				}),
			)
			.optional(),
	})
	.openapi({ ref: "QaConfigBody" });

// ---- zod -> AppError bridge --------------------------------------------------

/**
 * Parse `value` against `schema`, throwing `AppError("VALIDATION", ...)` with the
 * first issue (path-prefixed) on failure. Lets transports validate with zod while
 * surfacing the platform's typed error/HTTP status.
 */
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
	const result = schema.safeParse(value);
	if (!result.success) {
		const issue = result.error.issues[0];
		if (!issue) throw validation("Invalid input");
		const path = issue.path.join(".");
		throw validation(path ? `${path}: ${issue.message}` : issue.message);
	}
	return result.data;
}

// ---- imperative helpers (service layer) -------------------------------------

export function requireText(value: string, field: string): string {
	const v = (value ?? "").trim();
	if (!v) throw validation(`${field} is required`);
	return v;
}

export function requireEmail(value: string): string {
	const v = (value ?? "").trim().toLowerCase();
	if (!EMAIL_RE.test(v)) throw validation(`Invalid email: ${value}`);
	return v;
}

export function requireLocale(value: string, field: string): string {
	const v = (value ?? "").trim();
	if (!LOCALE_RE.test(v))
		throw validation(`${field} must be a locale code like "en" or "es-MX"`);
	return v;
}

export function requirePattern(
	value: string,
	re: RegExp,
	field: string,
): string {
	const v = (value ?? "").trim();
	if (!re.test(v)) throw validation(`Invalid ${field}: "${value}"`);
	return v;
}
