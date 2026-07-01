import {
	branchSchema,
	mergeResultSchema,
	type Operation,
	op,
	projectId,
	z,
} from "../base.js";

/** Branches: copy-on-write lines of work over a project's keys and translations.
 * `main` always exists and is the safe root; fork off it, translate freely, then
 * merge or abandon — `main` stays shippable throughout. */
export const branchOps: Operation[] = [
	op({
		name: "list_branches",
		description: "List the project's branches.",
		input: z.object({ projectId }),
		output: z.array(branchSchema),
		handler: (a, { service, actor }) =>
			service.branches.list(actor, a.projectId),
	}),
	op({
		name: "get_branch",
		description: "Get one branch by id (e.g. `main`).",
		input: z.object({ projectId, branch: z.string().describe("Branch id") }),
		output: branchSchema,
		handler: (a, { service, actor }) =>
			service.branches.get(actor, a.projectId, a.branch),
	}),
	op({
		name: "create_branch",
		description:
			"Fork a new copy-on-write branch off a parent (default `main`). It owns nothing until it writes — every unwritten read falls through to the parent — so it's a handful of rows, not a clone. Use for a feature, experiment, or A/B variant.",
		input: z.object({
			projectId,
			name: z.string().describe("Human label for the branch."),
			from: z
				.string()
				.optional()
				.describe("Parent branch to fork from (default main)."),
		}),
		output: branchSchema,
		handler: ({ projectId: id, ...input }, { service, actor }) =>
			service.branches.create(actor, id, input),
	}),
	op({
		name: "merge_branch",
		description:
			"Merge a branch into its parent: transport its accepted values (spends no budget). A cell the parent changed past the fork point is surfaced as an escalation, never overwritten; branch-introduced keys come along too. The branch is closed (`merged`).",
		input: z.object({
			projectId,
			branch: z.string().describe("The branch to merge into its parent."),
		}),
		output: mergeResultSchema,
		handler: (a, { service, actor }) =>
			service.branches.merge(actor, a.projectId, a.branch),
	}),
];
