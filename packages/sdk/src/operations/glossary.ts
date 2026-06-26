import {
	glossaryTermSchema,
	localeCode,
	type Operation,
	op,
	projectId,
	z,
} from "../base.js";

/** Glossary terms and translation-memory lookups. */
export const glossaryOps: Operation[] = [
	op({
		name: "list_glossary",
		description:
			"List the project's glossary terms. Read this BEFORE translating: honor doNotTranslate terms verbatim and prefer the given per-locale translations for consistency.",
		input: z.object({ projectId }),
		handler: (a, { service, actor }) =>
			service.glossary.list(actor, a.projectId),
	}),
	op({
		name: "add_glossary_term",
		description:
			"Add a glossary term. Use doNotTranslate for brand/product names that must stay verbatim, and translations for preferred per-locale renderings.",
		input: z.object({
			projectId,
			term: z.string(),
			translations: z
				.record(z.string())
				.optional()
				.describe("locale code -> preferred translation"),
			caseSensitive: z.boolean().optional(),
			doNotTranslate: z.boolean().optional(),
			notes: z.string().optional(),
		}),
		output: glossaryTermSchema,
		handler: ({ projectId: id, ...input }, { service, actor }) =>
			service.glossary.add(actor, id, input),
	}),
	op({
		name: "update_glossary_term",
		description: "Update a glossary term's translations, flags, or notes.",
		input: z.object({
			projectId,
			termId: z.string(),
			term: z.string().optional(),
			translations: z.record(z.string()).optional(),
			caseSensitive: z.boolean().optional(),
			doNotTranslate: z.boolean().optional(),
			notes: z.string().optional(),
		}),
		output: glossaryTermSchema,
		handler: ({ projectId: id, termId, ...patch }, { service, actor }) =>
			service.glossary.update(actor, id, termId, patch),
	}),
	op({
		name: "remove_glossary_term",
		description: "Delete a glossary term.",
		input: z.object({ projectId, termId: z.string() }),
		handler: async (a, { service, actor }) => {
			await service.glossary.remove(actor, a.projectId, a.termId);
			return { removed: a.termId };
		},
	}),
	op({
		name: "lookup_translation_memory",
		description:
			"Find prior translations for a source string in a locale (exact, normalized and fuzzy matches), so you can reuse existing phrasing for consistency before translating.",
		input: z.object({
			projectId,
			locale: localeCode,
			text: z.string().describe("Source (base-locale) text to look up"),
			limit: z.number().int().positive().max(20).optional(),
		}),
		handler: (a, { service, actor }) =>
			service.tm.lookup(actor, a.projectId, a.locale, a.text, a.limit),
	}),
];
