import {
	branchInput,
	bulkSetResultSchema,
	localeCode,
	localeKeyList,
	namespace,
	type Operation,
	op,
	pageCursor,
	pageLimit,
	projectId,
	translationSchema,
	z,
} from "../base.js";

/** Reading and writing translation values (the cell + its lifecycle). */
export const translationOps: Operation[] = [
	op({
		name: "get_translations",
		description:
			"Get translations either for one key across locales (pass name) or for an entire locale (pass locale). " +
			"The locale listing is paged — it returns up to `limit` translations (default 100, max 200) plus a " +
			"`nextCursor` to pass back as `cursor` for the next page.",
		input: z.object({
			projectId,
			locale: localeCode.optional(),
			name: z.string().optional(),
			namespace,
			branch: branchInput,
			limit: pageLimit,
			cursor: pageCursor,
		}),
		handler: (a, { service, actor }) => {
			if (a.name)
				return service.translations.listForKey(
					actor,
					a.projectId,
					a.name,
					a.namespace,
					a.branch,
				);
			if (a.locale)
				return service.translations.listForLocalePage(
					actor,
					a.projectId,
					a.locale,
					{ branch: a.branch, limit: a.limit ?? 100, cursor: a.cursor },
				);
			throw new Error("Provide either 'name' (for a key) or 'locale'.");
		},
	}),
	op({
		name: "list_untranslated",
		description:
			"List keys that have no value yet for a locale. Use this to find what to translate next. " +
			"Paged: returns up to `limit` keys (default 100, max 200) plus a `nextCursor` to fetch the next page.",
		input: z.object({
			projectId,
			locale: localeCode,
			branch: branchInput,
			limit: pageLimit,
			cursor: pageCursor,
		}),
		output: localeKeyList,
		handler: async (a, { service, actor }) => {
			const page = await service.translations.listUntranslatedPage(
				actor,
				a.projectId,
				a.locale,
				{ branch: a.branch, limit: a.limit ?? 100, cursor: a.cursor },
			);
			return {
				locale: a.locale,
				count: page.keys.length,
				keys: page.keys,
				nextCursor: page.nextCursor,
			};
		},
	}),
	op({
		name: "list_stale",
		description:
			"List keys whose translation for a locale is stale — its source (base) value changed since it was written. " +
			"Re-translate these to keep the locale current. Paged: returns up to `limit` keys (default 100, max 200) " +
			"plus a `nextCursor` to fetch the next page.",
		input: z.object({
			projectId,
			locale: localeCode,
			branch: branchInput,
			limit: pageLimit,
			cursor: pageCursor,
		}),
		output: localeKeyList,
		handler: async (a, { service, actor }) => {
			const page = await service.translations.listStalePage(
				actor,
				a.projectId,
				a.locale,
				{ branch: a.branch, limit: a.limit ?? 100, cursor: a.cursor },
			);
			return {
				locale: a.locale,
				count: page.keys.length,
				keys: page.keys,
				nextCursor: page.nextCursor,
			};
		},
	}),
	op({
		name: "set_translation",
		description:
			"Propose a translation value for an existing key in a locale. The cell lands as `proposed` " +
			"(awaiting acceptance); writing the base locale instead sets the source value. Edits the value, " +
			"not the key's metadata (use update_key for that). Accept it with accept_translation.",
		input: z.object({
			projectId,
			locale: localeCode,
			name: z.string(),
			namespace,
			branch: branchInput,
			value: z.string(),
		}),
		output: translationSchema,
		handler: (
			{ projectId: id, locale, branch, name, namespace: ns, value },
			{ service, actor },
		) =>
			service.translations.set(actor, id, locale, {
				name,
				namespace: ns,
				branch,
				value,
				origin: "agent",
			}),
	}),
	op({
		name: "bulk_set_translations",
		description:
			"Propose many translations for one locale in a single call. Ideal after translating a batch. " +
			"Each cell lands as `proposed`. Unknown keys are skipped and reported.",
		input: z.object({
			projectId,
			locale: localeCode,
			branch: branchInput,
			entries: z
				.array(
					z.object({
						name: z.string(),
						namespace,
						value: z.string(),
					}),
				)
				.min(1)
				// Bound the payload well under the 6 MB Lambda request limit; an agent
				// that has more than this should page its writes. Raise later if needed.
				.max(500),
		}),
		output: bulkSetResultSchema,
		handler: (a, { service, actor }) =>
			service.translations.bulkSet(
				actor,
				a.projectId,
				a.locale,
				a.entries.map((e) => ({ ...e, origin: "agent" as const })),
				a.branch,
			),
	}),
	op({
		name: "accept_translation",
		description:
			"Accept a key's current proposed value for a locale as its new head version — the controlled " +
			"accept transition. Appends an immutable version and advances the cell's head. When the project " +
			"requires human acceptance, a run-attributed accept is rejected.",
		input: z.object({
			projectId,
			locale: localeCode,
			name: z.string(),
			namespace,
			branch: branchInput,
			runRef: z
				.string()
				.optional()
				.describe(
					"Run id when a run is self-accepting; omit for a human accept.",
				),
		}),
		output: translationSchema,
		handler: (a, { service, actor }) =>
			service.translations.accept(actor, a.projectId, a.locale, a.name, {
				namespace: a.namespace,
				branch: a.branch,
				runRef: a.runRef,
			}),
	}),
];
