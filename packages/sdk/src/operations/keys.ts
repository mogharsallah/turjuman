import {
	branchInput,
	keyPageSchema,
	keyWithTranslationsSchema,
	namespace,
	type Operation,
	op,
	projectId,
	translationKeySchema,
	z,
} from "../base.js";

/** Translation keys (the strings to be translated). */
export const keyOps: Operation[] = [
	op({
		name: "list_keys",
		description:
			"List translation keys in a project, optionally filtered by namespace or tag. " +
			"For large projects pass `limit` to page; the response then includes `nextCursor` to pass back as `cursor`.",
		input: z.object({
			projectId,
			namespace,
			branch: branchInput,
			tag: z.string().optional(),
			limit: z
				.number()
				.int()
				.positive()
				.max(200)
				.optional()
				.describe("Page size; enables pagination"),
			cursor: z.string().optional().describe("nextCursor from a previous page"),
		}),
		handler: (a, { service, actor }) =>
			a.limit !== undefined || a.cursor !== undefined
				? service.keys.listPage(actor, a.projectId, {
						branch: a.branch,
						namespace: a.namespace,
						tag: a.tag,
						limit: a.limit,
						cursor: a.cursor,
					})
				: service.keys.list(actor, a.projectId, {
						branch: a.branch,
						namespace: a.namespace,
						tag: a.tag,
					}),
	}),
	op({
		name: "search_keys",
		description:
			"Search keys by name, description, or tag (substring match). Paged: returns up to `limit` " +
			"matches (default 100, max 200) plus a `nextCursor` to pass back as `cursor` for the next page.",
		input: z.object({
			projectId,
			query: z.string(),
			branch: branchInput,
			limit: z
				.number()
				.int()
				.positive()
				.max(200)
				.optional()
				.describe("Page size (default 100, max 200)"),
			cursor: z.string().optional().describe("nextCursor from a previous page"),
		}),
		// Always returns a page object (unlike list_keys, which is a bare array
		// unless paged), so it can declare a structured output schema.
		output: keyPageSchema,
		handler: (a, { service, actor }) =>
			service.keys.searchPage(actor, a.projectId, a.query, {
				branch: a.branch,
				limit: a.limit ?? 100,
				cursor: a.cursor,
			}),
	}),
	op({
		name: "get_key",
		description: "Get one key plus all of its translations across locales.",
		input: z.object({
			projectId,
			name: z.string(),
			namespace,
			branch: branchInput,
		}),
		output: keyWithTranslationsSchema,
		handler: (a, { service, actor }) =>
			service.keys.get(actor, a.projectId, a.name, a.namespace, a.branch),
	}),
	op({
		name: "create_key",
		description:
			"Create a translation key. Provide a clear description for translators/the LLM. Optionally set baseValue for the project's base locale.",
		input: z.object({
			projectId,
			name: z.string(),
			namespace,
			branch: branchInput,
			description: z
				.string()
				.optional()
				.describe("Context for translators and the LLM"),
			plural: z.boolean().optional(),
			maxLength: z.number().int().positive().optional(),
			tags: z.array(z.string()).max(50).optional(),
			baseValue: z.string().optional(),
		}),
		output: translationKeySchema,
		handler: ({ projectId: id, ...input }, { service, actor }) =>
			service.keys.create(actor, id, input),
	}),
	op({
		name: "update_key",
		description:
			"Update a key's metadata (description, plural flag, maxLength, tags, noTranslate) — not its " +
			"translated text or its name. Use set_translation to write a value, rename_key to rename it.",
		input: z.object({
			projectId,
			name: z.string(),
			namespace,
			branch: branchInput,
			description: z.string().optional(),
			plural: z.boolean().optional(),
			maxLength: z.number().int().positive().optional(),
			tags: z.array(z.string()).max(50).optional(),
			noTranslate: z.boolean().optional(),
		}),
		output: translationKeySchema,
		handler: (
			{ projectId: id, name, namespace: ns, branch, ...patch },
			{ service, actor },
		) => service.keys.update(actor, id, name, patch, ns, branch),
	}),
	op({
		name: "rename_key",
		description:
			"Move a key to a new name and/or namespace. Its identity and all of its translations are " +
			"preserved — only the labels change. Conflicts if the destination name is already taken.",
		input: z.object({
			projectId,
			name: z.string().describe("Current key name"),
			namespace,
			branch: branchInput,
			newName: z.string().optional().describe("New name (omit to keep)"),
			newNamespace: z
				.string()
				.optional()
				.describe("New namespace (omit to keep; empty to remove)"),
		}),
		output: translationKeySchema,
		handler: (a, { service, actor }) =>
			service.keys.rename(
				actor,
				a.projectId,
				a.name,
				{ name: a.newName, namespace: a.newNamespace },
				a.namespace,
				a.branch,
			),
	}),
	op({
		name: "delete_key",
		description:
			"DESTRUCTIVE: delete a key and all of its translations across every locale. Set confirm=true to proceed.",
		input: z.object({
			projectId,
			name: z.string(),
			namespace,
			branch: branchInput,
			confirm: z.boolean().describe("Must be true to delete"),
		}),
		handler: async (a, { service, actor }) => {
			await service.keys.delete(
				actor,
				a.projectId,
				a.name,
				a.confirm,
				a.namespace,
				a.branch,
			);
			return { deleted: a.name };
		},
	}),
];
