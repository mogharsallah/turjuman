import {
  type ToolDef,
  keyPageSchema,
  keyWithTranslationsSchema,
  namespace,
  projectId,
  tool,
  translationKeySchema,
  z,
} from "./base.js";

/** Translation keys (the strings to be translated). */
export const keyTools: ToolDef[] = [
  tool({
    name: "list_keys",
    description:
      "List translation keys in a project, optionally filtered by namespace or tag. " +
      "For large projects pass `limit` to page; the response then includes `nextCursor` to pass back as `cursor`.",
    input: z.object({
      projectId,
      namespace,
      tag: z.string().optional(),
      limit: z.number().int().positive().max(200).optional().describe("Page size; enables pagination"),
      cursor: z.string().optional().describe("nextCursor from a previous page"),
    }),
    handler: (a, { service, actor }) =>
      a.limit !== undefined || a.cursor !== undefined
        ? service.keys.listPage(actor, a.projectId, {
            namespace: a.namespace,
            tag: a.tag,
            limit: a.limit,
            cursor: a.cursor,
          })
        : service.keys.list(actor, a.projectId, { namespace: a.namespace, tag: a.tag }),
  }),
  tool({
    name: "search_keys",
    description:
      "Search keys by name, description, or tag (substring match). Paged: returns up to `limit` " +
      "matches (default 100, max 200) plus a `nextCursor` to pass back as `cursor` for the next page.",
    input: z.object({
      projectId,
      query: z.string(),
      limit: z.number().int().positive().max(200).optional().describe("Page size (default 100, max 200)"),
      cursor: z.string().optional().describe("nextCursor from a previous page"),
    }),
    // Always returns a page object (unlike list_keys, which is a bare array
    // unless paged), so it can declare a structured output schema.
    output: keyPageSchema,
    handler: (a, { service, actor }) =>
      service.keys.searchPage(actor, a.projectId, a.query, { limit: a.limit ?? 100, cursor: a.cursor }),
  }),
  tool({
    name: "get_key",
    description: "Get one key plus all of its translations across locales.",
    input: z.object({ projectId, name: z.string(), namespace }),
    output: keyWithTranslationsSchema,
    handler: (a, { service, actor }) =>
      service.keys.get(actor, a.projectId, a.name, a.namespace),
  }),
  tool({
    name: "create_key",
    description:
      "Create a translation key. Provide a clear description for translators/the LLM. Optionally set baseValue for the project's base locale.",
    input: z.object({
      projectId,
      name: z.string(),
      namespace,
      description: z.string().optional().describe("Context for translators and the LLM"),
      plural: z.boolean().optional(),
      maxLength: z.number().int().positive().optional(),
      tags: z.array(z.string()).max(50).optional(),
      baseValue: z.string().optional(),
    }),
    output: translationKeySchema,
    handler: ({ projectId: id, ...input }, { service, actor }) =>
      service.keys.create(actor, id, input),
  }),
  tool({
    name: "update_key",
    description:
      "Update a key's metadata (description, plural flag, maxLength, tags) — not its translated text. To write a translation value, use set_translation.",
    input: z.object({
      projectId,
      name: z.string(),
      namespace,
      description: z.string().optional(),
      plural: z.boolean().optional(),
      maxLength: z.number().int().positive().optional(),
      tags: z.array(z.string()).max(50).optional(),
    }),
    output: translationKeySchema,
    handler: ({ projectId: id, name, namespace: ns, ...patch }, { service, actor }) =>
      service.keys.update(actor, id, name, patch, ns),
  }),
  tool({
    name: "delete_key",
    description:
      "DESTRUCTIVE: delete a key and all of its translations across every locale. Set confirm=true to proceed.",
    input: z.object({
      projectId,
      name: z.string(),
      namespace,
      confirm: z.boolean().describe("Must be true to delete"),
    }),
    handler: async (a, { service, actor }) => {
      await service.keys.delete(actor, a.projectId, a.name, a.confirm, a.namespace);
      return { deleted: a.name };
    },
  }),
];
