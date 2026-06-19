import {
  type ToolDef,
  localeCodeSchema,
  localeSchema,
  projectId,
  projectSchema,
  tool,
  z,
} from "./base.js";

/** Projects and their locales. */
export const projectTools: ToolDef[] = [
  tool({
    name: "list_projects",
    description: "List projects you can access in your organization.",
    input: z.object({}),
    handler: (_a, { service, actor }) => service.projects.list(actor),
  }),
  tool({
    name: "get_project",
    description: "Get a single project's details.",
    input: z.object({ projectId }),
    output: projectSchema,
    handler: (a, { service, actor }) => service.projects.get(actor, a.projectId),
  }),
  tool({
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
  tool({
    name: "update_project",
    description: "Update a project's name, description, or base locale.",
    input: z.object({
      projectId,
      name: z.string().optional(),
      description: z.string().optional(),
      baseLocale: localeCodeSchema.optional(),
    }),
    output: projectSchema,
    handler: ({ projectId: id, ...patch }, { service, actor }) =>
      service.projects.update(actor, id, patch),
  }),
  tool({
    name: "list_locales",
    description: "List the locales (target languages) configured on a project.",
    input: z.object({ projectId }),
    handler: (a, { service, actor }) => service.locales.list(actor, a.projectId),
  }),
  tool({
    name: "add_locale",
    description:
      'Add (attach) a target locale to an existing project, e.g. "fr" or "es-MX". To create the project itself, use create_project.',
    input: z.object({ projectId, code: localeCodeSchema, name: z.string().optional() }),
    output: localeSchema,
    handler: (a, { service, actor }) => service.locales.add(actor, a.projectId, a.code, a.name),
  }),
];
