import { branchSchema, type Operation, op, projectId, z } from "../base.js";

/** Branches: copy-on-write lines of work. In this batch only `main` exists;
 * diverging and merging arrive in a later batch. */
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
];
