import { translationOriginSchema } from "@turjuman/core";
import {
	branchInput,
	exampleQualitySchema,
	exampleSchema,
	localeCode,
	namespace,
	type Operation,
	op,
	projectId,
	scopeInputSchema,
	z,
} from "../base.js";

/** Examples: the few-shot / translation-memory corpus, retrieved deterministically
 * (no embeddings). `find_examples` replaces the old translation-memory lookup. */
export const exampleOps: Operation[] = [
	op({
		name: "find_examples",
		description:
			"Retrieve the most relevant translation examples for one key × locale — in-scope, ranked by proximity → quality → recency (deterministic, no embeddings). Use as few-shot guidance before translating.",
		input: z.object({
			projectId,
			locale: localeCode,
			name: z.string(),
			namespace,
			branch: branchInput,
		}),
		output: z.array(exampleSchema),
		annotations: { readOnlyHint: true },
		handler: (a, { service, actor }) =>
			service.examples.find(actor, a.projectId, a.locale, a.name, {
				namespace: a.namespace,
				branch: a.branch,
			}),
	}),
	op({
		name: "list_examples",
		description: "List the project's stored translation examples (the corpus).",
		input: z.object({ projectId }),
		output: z.array(exampleSchema),
		handler: (a, { service, actor }) =>
			service.examples.list(actor, a.projectId),
	}),
	op({
		name: "add_example",
		description:
			"Add a translation example (a source → target pair) to the corpus, scoped for retrieval. Use `gold` quality for vetted human examples.",
		input: z.object({
			projectId,
			locale: localeCode,
			scope: scopeInputSchema.optional(),
			sourceText: z.string(),
			targetText: z.string(),
			quality: exampleQualitySchema.optional(),
			origin: translationOriginSchema.optional(),
		}),
		output: exampleSchema,
		handler: ({ projectId: id, ...input }, { service, actor }) =>
			service.examples.add(actor, id, input),
	}),
	op({
		name: "remove_example",
		description: "Delete a stored example.",
		input: z.object({ projectId, exampleId: z.string() }),
		handler: async (a, { service, actor }) => {
			await service.examples.remove(actor, a.projectId, a.exampleId);
			return { removed: a.exampleId };
		},
	}),
];
