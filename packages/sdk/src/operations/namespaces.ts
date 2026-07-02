import {
	namespaceEntitySchema,
	namespaceSchema,
	type Operation,
	op,
	projectId,
	z,
} from "../base.js";

/** Namespaces: opaque-id groupings of keys by feature-area, with a renamable name. */
export const namespaceOps: Operation[] = [
	op({
		name: "list_namespaces",
		description: "List the project's namespaces (key groupings).",
		input: z.object({ projectId }),
		output: z.array(namespaceEntitySchema),
		handler: (a, { service, actor }) =>
			service.namespaces.list(actor, a.projectId),
	}),
	op({
		name: "get_namespace",
		description: "Get one namespace by id.",
		input: z.object({ projectId, namespaceId: z.string() }),
		output: namespaceEntitySchema,
		handler: (a, { service, actor }) =>
			service.namespaces.get(actor, a.projectId, a.namespaceId),
	}),
	op({
		name: "create_namespace",
		description:
			"Create a namespace. The name is a display label (unique per project); keys reference the id.",
		input: z.object({
			projectId,
			name: namespaceSchema,
			title: z.string().optional(),
			description: z.string().optional(),
		}),
		output: namespaceEntitySchema,
		handler: ({ projectId: id, ...input }, { service, actor }) =>
			service.namespaces.create(actor, id, input),
	}),
	op({
		name: "update_namespace",
		description:
			"Update a namespace's name, title, description, or lifecycle. Renaming it leaves every key's reference intact.",
		input: z.object({
			projectId,
			namespaceId: z.string(),
			name: namespaceSchema.optional(),
			title: z.string().optional(),
			description: z.string().optional(),
			lifecycle: z.enum(["active", "deprecated"]).optional(),
		}),
		output: namespaceEntitySchema,
		handler: ({ projectId: id, namespaceId, ...patch }, { service, actor }) =>
			service.namespaces.update(actor, id, namespaceId, patch),
	}),
];
