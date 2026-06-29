import {
	glossaryTermSchema,
	type Operation,
	op,
	projectId,
	z,
} from "../base.js";

/** Glossary terms (preferred renderings + do-not-translate). */
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
];
