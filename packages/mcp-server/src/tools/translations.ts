import {
  type ToolDef,
  bulkSetResultSchema,
  localeCode,
  namespace,
  projectId,
  settableStatusSchema,
  tool,
  translationKeySchema,
  translationSchema,
  translationStatusSchema,
  z,
} from "./base.js";

/** Shared shape for the locale-scoped key lists (untranslated/stale): the
 * keys plus the locale and a count, so a client gets context without a
 * second call. The lists are paged, so `count` is this page's size and
 * `nextCursor` (when present) fetches the next page. */
const localeKeyList = z.object({
  locale: z.string(),
  count: z.number().int(),
  keys: z.array(translationKeySchema),
  nextCursor: z.string().optional(),
});

/** Page-size + cursor inputs shared by the paged growth tools (matches `list_keys`). */
const pageLimit = z
  .number()
  .int()
  .positive()
  .max(200)
  .optional()
  .describe("Page size (default 100, max 200)");
const pageCursor = z.string().optional().describe("nextCursor from a previous page");

/** Reading and writing translation values. */
export const translationTools: ToolDef[] = [
  tool({
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
      limit: pageLimit,
      cursor: pageCursor,
    }),
    handler: (a, { service, actor }) => {
      if (a.name) return service.translations.listForKey(actor, a.projectId, a.name, a.namespace);
      if (a.locale)
        return service.translations.listForLocalePage(actor, a.projectId, a.locale, {
          limit: a.limit ?? 100,
          cursor: a.cursor,
        });
      throw new Error("Provide either 'name' (for a key) or 'locale'.");
    },
  }),
  tool({
    name: "list_untranslated",
    description:
      "List keys that have no value yet for a locale. Use this to find what the LLM should translate. " +
      "Paged: returns up to `limit` keys (default 100, max 200) plus a `nextCursor` to fetch the next page.",
    input: z.object({ projectId, locale: localeCode, limit: pageLimit, cursor: pageCursor }),
    output: localeKeyList,
    handler: async (a, { service, actor }) => {
      const page = await service.translations.listUntranslatedPage(actor, a.projectId, a.locale, {
        limit: a.limit ?? 100,
        cursor: a.cursor,
      });
      return { locale: a.locale, count: page.keys.length, keys: page.keys, nextCursor: page.nextCursor };
    },
  }),
  tool({
    name: "list_stale",
    description:
      "List keys whose translation for a locale is stale — its source (base) value changed since it was written. " +
      "Re-translate these to keep the locale current. Paged: returns up to `limit` keys (default 100, max 200) " +
      "plus a `nextCursor` to fetch the next page.",
    input: z.object({ projectId, locale: localeCode, limit: pageLimit, cursor: pageCursor }),
    output: localeKeyList,
    handler: async (a, { service, actor }) => {
      const page = await service.translations.listStalePage(actor, a.projectId, a.locale, {
        limit: a.limit ?? 100,
        cursor: a.cursor,
      });
      return { locale: a.locale, count: page.keys.length, keys: page.keys, nextCursor: page.nextCursor };
    },
  }),
  tool({
    name: "set_translation",
    description:
      "Write (create or replace) a single translation value for an existing key in a locale. Edits the value, not the key's metadata (use update_key for that).",
    input: z.object({
      projectId,
      locale: localeCode,
      name: z.string(),
      namespace,
      value: z.string(),
      status: settableStatusSchema.optional(),
    }),
    output: translationSchema,
    handler: ({ projectId: id, locale, ...input }, { service, actor }) =>
      service.translations.set(actor, id, locale, { ...input, origin: "llm" }),
  }),
  tool({
    name: "bulk_set_translations",
    description:
      "Set many translations for one locale in a single call. Ideal after the LLM translates a batch. Unknown keys are skipped and reported.",
    input: z.object({
      projectId,
      locale: localeCode,
      entries: z
        .array(
          z.object({
            name: z.string(),
            namespace,
            value: z.string(),
            status: settableStatusSchema.optional(),
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
        a.entries.map((e) => ({ ...e, origin: "llm" as const })),
      ),
  }),
  tool({
    name: "set_translation_status",
    description: 'Change a translation\'s status (e.g. mark it "approved").',
    input: z.object({
      projectId,
      locale: localeCode,
      name: z.string(),
      namespace,
      status: translationStatusSchema,
    }),
    output: translationSchema,
    handler: (a, { service, actor }) =>
      service.translations.setStatus(actor, a.projectId, a.locale, a.name, a.status, a.namespace),
  }),
];
