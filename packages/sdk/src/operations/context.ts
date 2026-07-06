import {
	branchInput,
	briefSchema,
	contextLifecycleSchema,
	contextOperatorSchema,
	contextRuleKindSchema,
	contextRuleSchema,
	localeCode,
	namespace,
	type Operation,
	op,
	projectId,
	resolvedContextSchema,
	scopeInputSchema,
	z,
} from "../base.js";

/** The context layer: scoped rules + the cascade resolver the agent translates
 * against. The brief is the single read an agent makes before translating a string. */
export const contextOps: Operation[] = [
	op({
		name: "list_context_rules",
		description:
			"List the project's context rules (voice / length / format / compliance), each scoped and folded by its merge operator.",
		input: z.object({ projectId }),
		output: z.array(contextRuleSchema),
		handler: (a, { service, actor }) =>
			service.context.listRules(actor, a.projectId),
	}),
	op({
		name: "create_context_rule",
		description:
			"Create a scoped context rule. `kind` picks the payload shape (voice `{tone,formality}`, length `{max}`, compliance `{mustInclude,mustAvoid}`); `operator` defaults from the kind (voice→override, compliance→restrict). Omit a `scope` field to broaden (no key = the whole namespace/project; no locale = all locales).",
		input: z.object({
			projectId,
			scope: scopeInputSchema.optional(),
			kind: contextRuleKindSchema,
			operator: contextOperatorSchema.optional(),
			payload: z
				.record(z.unknown())
				.optional()
				.describe("Kind-specific fields."),
			hard: z
				.boolean()
				.optional()
				.describe("A rule a child scope cannot loosen (folds as restrict)."),
		}),
		output: contextRuleSchema,
		handler: ({ projectId: id, ...input }, { service, actor }) =>
			service.context.createRule(actor, id, input),
	}),
	op({
		name: "update_context_rule",
		description:
			"Update a context rule's payload, operator, hard flag, or lifecycle (retire it with lifecycle `retired`/`archived`).",
		input: z.object({
			projectId,
			ruleId: z.string(),
			payload: z.record(z.unknown()).optional(),
			operator: contextOperatorSchema.optional(),
			hard: z.boolean().optional(),
			lifecycle: contextLifecycleSchema.optional(),
		}),
		output: contextRuleSchema,
		handler: ({ projectId: id, ruleId, ...patch }, { service, actor }) =>
			service.context.updateRule(actor, id, ruleId, patch),
	}),
	op({
		name: "delete_context_rule",
		description: "Delete a context rule.",
		input: z.object({ projectId, ruleId: z.string() }),
		handler: async (a, { service, actor }) => {
			await service.context.deleteRule(actor, a.projectId, a.ruleId);
			return { removed: a.ruleId };
		},
	}),
	op({
		name: "resolve_context",
		description:
			"Resolve the folded context cascade for one key × locale: voice, constraints, glossary, examples, provenance, restrict conflicts, the locale shape (plurals/RTL), and the review-depth signal.",
		input: z.object({
			projectId,
			locale: localeCode,
			name: z.string(),
			namespace,
			branch: branchInput,
		}),
		output: resolvedContextSchema,
		annotations: { readOnlyHint: true },
		handler: (a, { service, actor }) =>
			service.context.resolve(actor, a.projectId, a.locale, a.name, {
				namespace: a.namespace,
				branch: a.branch,
			}),
	}),
	op({
		name: "get_brief",
		description:
			"The agent briefing for one key × locale: the key, its base value, and the resolved context cascade. Call this before translating a string — it is everything you need to translate it well.",
		input: z.object({
			projectId,
			locale: localeCode,
			name: z.string(),
			namespace,
			branch: branchInput,
		}),
		output: briefSchema,
		annotations: { readOnlyHint: true },
		handler: (a, { service, actor }) =>
			service.context.brief(actor, a.projectId, a.locale, a.name, {
				namespace: a.namespace,
				branch: a.branch,
			}),
	}),
];
