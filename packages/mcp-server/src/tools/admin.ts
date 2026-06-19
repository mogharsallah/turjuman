import {
  type ToolDef,
  apiKeyCreatedSchema,
  emailSchema,
  globalRole,
  membershipSchema,
  projectId,
  projectRole,
  tool,
  userSchema,
  z,
} from "./base.js";

/** Org users, project members, and API keys (admin surface). */
export const adminTools: ToolDef[] = [
  tool({
    name: "list_users",
    description: "List users in your organization.",
    input: z.object({}),
    handler: (_a, { service, actor }) => service.users.list(actor),
  }),
  tool({
    name: "create_user",
    description:
      "Create a user identity (so they can be assigned project roles and API keys). Requires admin.",
    input: z.object({ email: emailSchema, name: z.string(), globalRole: globalRole.optional() }),
    output: userSchema,
    handler: (a, { service, actor }) => service.users.create(actor, a),
  }),
  tool({
    name: "set_user_role",
    description: "Set a user's organization-wide role. Requires admin.",
    input: z.object({ userId: z.string(), globalRole }),
    handler: async (a, { service, actor }) => {
      await service.users.setGlobalRole(actor, a.userId, a.globalRole);
      return { userId: a.userId, globalRole: a.globalRole };
    },
  }),
  tool({
    name: "list_members",
    description: "List the members of a project and their roles.",
    input: z.object({ projectId }),
    handler: (a, { service, actor }) => service.members.list(actor, a.projectId),
  }),
  tool({
    name: "add_member",
    description:
      "Grant a user a role on a project. Identify the user by userId or email. " +
      "If the email isn't a user yet and you have admin rights, they are provisioned automatically (pass `name` to set their display name).",
    input: z.object({
      projectId,
      userId: z.string().optional(),
      email: emailSchema.optional(),
      name: z.string().optional().describe("Display name when provisioning a new user by email"),
      role: projectRole,
    }),
    output: membershipSchema,
    handler: (a, { service, actor }) =>
      service.members.add(
        actor,
        a.projectId,
        { userId: a.userId, email: a.email, name: a.name },
        a.role,
      ),
  }),
  tool({
    name: "set_member_role",
    description: "Change an existing member's role on a project.",
    input: z.object({ projectId, userId: z.string(), role: projectRole }),
    output: membershipSchema,
    handler: (a, { service, actor }) =>
      service.members.setRole(actor, a.projectId, a.userId, a.role),
  }),
  tool({
    name: "remove_member",
    description:
      "Detach a user from a project (revokes their project role). Removes the membership only — it does not delete the user account.",
    input: z.object({ projectId, userId: z.string() }),
    handler: async (a, { service, actor }) => {
      await service.members.remove(actor, a.projectId, a.userId);
      return { removed: a.userId };
    },
  }),
  tool({
    name: "create_api_key",
    description:
      "Create an API key. Omit userId to create one for yourself. The secret is returned ONCE — store it securely. Pass readOnly to mint a key limited to read actions (e.g. CI pulls), and expiresAt to set an expiry.",
    input: z.object({
      name: z.string(),
      userId: z.string().optional(),
      readOnly: z.boolean().optional().describe("Limit the key to read-only actions, regardless of the user's role"),
      expiresAt: z
        .string()
        .optional()
        .describe("ISO-8601 expiry (must be in the future); after this the key stops working"),
    }),
    output: apiKeyCreatedSchema,
    handler: async (a, { service, actor }) => {
      const { apiKey, secret } = await service.apiKeys.create(actor, a);
      return {
        id: apiKey.id,
        name: apiKey.name,
        prefix: apiKey.prefix,
        readOnly: apiKey.readOnly ?? false,
        expiresAt: apiKey.expiresAt,
        secret,
      };
    },
  }),
  tool({
    name: "list_api_keys",
    description: "List API key metadata (never the secret) for yourself or, as admin, another user.",
    input: z.object({ userId: z.string().optional() }),
    handler: (a, { service, actor }) => service.apiKeys.list(actor, a.userId),
  }),
  tool({
    name: "revoke_api_key",
    description:
      "Permanently revoke an API key by id (from list_api_keys). Revoking your own key is always allowed; revoking another user's key requires admin. Use this immediately if a key leaks.",
    input: z.object({
      apiKeyId: z.string().describe("API key id (key_...), from list_api_keys"),
      userId: z.string().optional().describe("Owner of the key; defaults to yourself"),
    }),
    handler: (a, { service, actor }) => service.apiKeys.revoke(actor, a.apiKeyId, a.userId),
  }),
];
