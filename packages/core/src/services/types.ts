import type {
	ContextLifecycle,
	TranslationOrigin,
	WebhookEvent,
} from "@turjuman/schema";
import type { ScopeInput } from "./context.js";

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
	branch?: string;
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
	/** Keep the whole key verbatim across locales (brand names, codes). */
	noTranslate?: boolean;
}

export interface SetTranslationInput {
	namespace?: string;
	branch?: string;
	name: string;
	value: string;
	/** Provenance of the value; stamped onto the cell when known. */
	origin?: TranslationOrigin;
}

export interface AddGlossaryTermInput {
	term: string;
	/** Cascade coordinate; absent = project-wide. */
	scope?: ScopeInput;
	translations?: Record<string, string>;
	caseSensitive?: boolean;
	doNotTranslate?: boolean;
	notes?: string;
}

export type UpdateGlossaryTermInput = Partial<AddGlossaryTermInput> & {
	lifecycle?: ContextLifecycle;
};

export interface AddWebhookInput {
	url: string;
	events?: (WebhookEvent | "*")[];
}
