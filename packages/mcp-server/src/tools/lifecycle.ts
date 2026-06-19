import { type ToolDef, projectId, tool, webhookSchema, z } from "./base.js";

/** Webhooks and destructive project lifecycle. */
export const lifecycleTools: ToolDef[] = [
  tool({
    name: "list_webhooks",
    description: "List a project's webhooks (including their signing secrets).",
    input: z.object({ projectId }),
    handler: (a, { service, actor }) => service.webhooks.list(actor, a.projectId),
  }),
  tool({
    name: "add_webhook",
    description:
      "Register a webhook that receives HMAC-signed POSTs on changes. Events: translation.updated, translation.stale, key.created, key.updated, key.deleted, locale.added (or '*' for all).",
    input: z.object({
      projectId,
      url: z.string().describe("https endpoint to POST events to"),
      // Reuse the entity's own events field (core's webhookSchema) so the
      // subscribable set can never drift from what the dispatcher emits.
      events: webhookSchema.shape.events.optional(),
    }),
    output: webhookSchema,
    handler: (a, { service, actor }) =>
      service.webhooks.add(actor, a.projectId, { url: a.url, events: a.events }),
  }),
  tool({
    name: "remove_webhook",
    description: "Delete a webhook.",
    input: z.object({ projectId, webhookId: z.string() }),
    handler: async (a, { service, actor }) => {
      await service.webhooks.remove(actor, a.projectId, a.webhookId);
      return { removed: a.webhookId };
    },
  }),
  tool({
    name: "delete_project",
    description:
      "DESTRUCTIVE: permanently delete a project and ALL its locales, keys, translations, members, glossary and webhooks. Set confirm=true to proceed.",
    input: z.object({ projectId, confirm: z.boolean().describe("Must be true to delete") }),
    handler: (a, { service, actor }) => service.projects.delete(actor, a.projectId, a.confirm),
  }),
];
