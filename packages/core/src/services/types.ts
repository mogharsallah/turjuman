import type {
	TranslationOrigin,
	TranslationStatus,
	WebhookEvent,
} from "@turjuman/schema";

// Aggregate/page/result shapes the services return are defined once in `wire.ts`
// (the transport-facing schemas) and re-exported here as their inferred types,
// so the service signatures and the documented MCP/OpenAPI schemas share a single
// definition and cannot drift.
export type {
	BundleEntry,
	BundlePage,
	KeyPage,
	KeyWithTranslations,
	TranslationPage,
} from "@turjuman/schema";

export interface CreateProjectInput {
	name: string;
	baseLocale: string;
	description?: string;
}

export interface CreateKeyInput {
	namespace?: string;
	name: string;
	description?: string;
	plural?: boolean;
	maxLength?: number;
	tags?: string[];
	/** Optional initial value for the project's base locale (developer push). */
	baseValue?: string;
}

export interface UpdateKeyInput {
	description?: string;
	plural?: boolean;
	maxLength?: number;
	tags?: string[];
}

export interface SetTranslationInput {
	namespace?: string;
	name: string;
	value: string;
	status?: Exclude<TranslationStatus, "untranslated">;
	/** Provenance of the value; stamped onto the translation when known. */
	origin?: TranslationOrigin;
}

export interface AddGlossaryTermInput {
	term: string;
	translations?: Record<string, string>;
	caseSensitive?: boolean;
	doNotTranslate?: boolean;
	notes?: string;
}

export type UpdateGlossaryTermInput = Partial<AddGlossaryTermInput>;

/** A translation-memory suggestion: a prior source/target pair and its match score. */
export interface TmMatch {
	source: string;
	target: string;
	score: number;
	key: string;
	namespace: string;
}

export interface AddWebhookInput {
	url: string;
	events?: (WebhookEvent | "*")[];
}
