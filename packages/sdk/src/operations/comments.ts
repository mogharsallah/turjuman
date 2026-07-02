import {
	commentSchema,
	localeCode,
	namespace,
	type Operation,
	op,
	projectId,
	z,
} from "../base.js";

/** Comments: threaded human discussion on a `(key, locale)` string, shared across
 * branches — where the judgment a lifecycle flag can't carry gets recorded. */
export const commentOps: Operation[] = [
	op({
		name: "add_comment",
		description:
			"Add a comment to a `(key, locale)` string — threaded discussion shared across branches. Use `parentId` to reply within a thread.",
		input: z.object({
			projectId,
			locale: localeCode,
			name: z.string(),
			namespace,
			body: z.string(),
			parentId: z.string().optional(),
		}),
		output: commentSchema,
		handler: ({ projectId: id, locale, name, ...input }, { service, actor }) =>
			service.comments.add(actor, id, locale, name, input),
	}),
	op({
		name: "list_comments",
		description: "List the comment thread on a `(key, locale)` string.",
		input: z.object({
			projectId,
			locale: localeCode,
			name: z.string(),
			namespace,
		}),
		output: z.array(commentSchema),
		handler: (a, { service, actor }) =>
			service.comments.list(actor, a.projectId, a.locale, a.name, {
				namespace: a.namespace,
			}),
	}),
];
