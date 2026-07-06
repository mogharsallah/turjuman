import {
	localeCodeSchema,
	localeSchema,
	type Operation,
	op,
	projectId,
	projectSchema,
	z,
} from "../base.js";

/** Projects and their locales. */
export const projectOps: Operation[] = [
	op({
		name: "list_projects",
		description: "List projects you can access in your organization.",
		input: z.object({}),
		handler: (_a, { service, actor }) => service.projects.list(actor),
	}),
	op({
		name: "get_project",
		description: "Get a single project's details.",
		input: z.object({ projectId }),
		output: projectSchema,
		http: {
			method: "get",
			path: "/v1/projects/:id",
			params: { id: "projectId" },
		},
		handler: (a, { service, actor }) =>
			service.projects.get(actor, a.projectId),
	}),
	op({
		name: "create_project",
		description:
			"Create a new project. The base locale is the source language all keys are authored in.",
		input: z.object({
			name: z.string(),
			baseLocale: localeCodeSchema.describe('Source locale code, e.g. "en"'),
			description: z.string().optional(),
		}),
		output: projectSchema,
		handler: (a, { service, actor }) => service.projects.create(actor, a),
	}),
	op({
		name: "update_project",
		description:
			"Update a project's name, description, base locale, or accept policy " +
			"(requireHumanAccept: when true, a run cannot self-accept — only a human can).",
		input: z.object({
			projectId,
			name: z.string().optional(),
			description: z.string().optional(),
			baseLocale: localeCodeSchema.optional(),
			requireHumanAccept: z.boolean().optional(),
		}),
		output: projectSchema,
		handler: ({ projectId: id, ...patch }, { service, actor }) =>
			service.projects.update(actor, id, patch),
	}),
	op({
		name: "list_locales",
		description: "List the locales (target languages) configured on a project.",
		input: z.object({ projectId }),
		handler: (a, { service, actor }) =>
			service.locales.list(actor, a.projectId),
	}),
	op({
		name: "add_locale",
		description:
			'Add (attach) a target locale to an existing project, e.g. "fr" or "es-MX". To create the project itself, use create_project.',
		input: z.object({
			projectId,
			code: localeCodeSchema,
			name: z.string().optional(),
		}),
		output: localeSchema,
		http: {
			method: "post",
			path: "/v1/projects/:id/locales",
			params: { id: "projectId" },
		},
		handler: (a, { service, actor }) =>
			service.locales.add(actor, a.projectId, a.code, a.name),
	}),
];
