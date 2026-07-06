import {
	branchInput,
	escalationSchema,
	escalationStatusSchema,
	localeCode,
	namespace,
	type Operation,
	op,
	projectId,
	z,
} from "../base.js";

/** Escalations: the review router's human terminal exit. Open one only for
 * irreducible judgment the agent can't resolve by re-looping. */
export const escalationOps: Operation[] = [
	op({
		name: "escalate_translation",
		description:
			"Escalate a translation to a human: flip the cell to `escalated` and open an escalation with a reason. Use only for irreducible judgment — prefer re-looping with new context first.",
		input: z.object({
			projectId,
			locale: localeCode,
			name: z.string(),
			namespace,
			branch: branchInput,
			reason: z.string(),
			assigneeUserId: z.string().optional(),
		}),
		output: escalationSchema,
		handler: ({ projectId: id, locale, name, ...input }, { service, actor }) =>
			service.escalations.open(actor, id, locale, name, input),
	}),
	op({
		name: "list_escalations",
		description:
			"List the project's escalations, optionally filtered by status (`open` / `resolved`).",
		input: z.object({ projectId, status: escalationStatusSchema.optional() }),
		output: z.array(escalationSchema),
		handler: (a, { service, actor }) =>
			service.escalations.list(actor, a.projectId, { status: a.status }),
	}),
	op({
		name: "claim_escalation",
		description:
			"Claim an open escalation for yourself — a compare-and-swap, so a second concurrent claim loses.",
		input: z.object({ projectId, escalationId: z.string() }),
		output: escalationSchema,
		handler: (a, { service, actor }) =>
			service.escalations.claim(actor, a.projectId, a.escalationId),
	}),
	op({
		name: "resolve_escalation",
		description:
			"Resolve an escalation: accept the chosen value (defaults to the cell's draft) and optionally spawn a gold Example or a glossary term so the human decision becomes reusable context.",
		input: z.object({
			projectId,
			escalationId: z.string(),
			value: z.string().optional(),
			spawnExample: z.boolean().optional(),
			spawnGlossary: z
				.object({
					term: z.string(),
					translations: z.record(z.string()).optional(),
				})
				.optional(),
		}),
		output: escalationSchema,
		handler: ({ projectId: id, escalationId, ...input }, { service, actor }) =>
			service.escalations.resolve(actor, id, escalationId, input),
	}),
];
