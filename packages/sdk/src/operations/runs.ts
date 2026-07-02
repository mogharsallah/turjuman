import { runTriggerSchema } from "@turjuman/core";
import {
	branchInput,
	type Operation,
	op,
	projectId,
	translationRunSchema,
	z,
} from "../base.js";

/** Translation runs: the recorded agent write primitive. A run captures what an
 * agent did to a branch (trigger, value source, progress, recorded budget). In
 * this batch a run is bookkeeping; the controlled accept is accept_translation. */
export const runOps: Operation[] = [
	op({
		name: "start_run",
		description:
			"Open a translation run to record a batch of agent work on a branch. Returns the run (status `running`).",
		input: z.object({
			projectId,
			branch: branchInput,
			trigger: runTriggerSchema.optional(),
			valueSource: z
				.string()
				.optional()
				.describe("`agent` (generated) or `branch:<id>` (a merge)."),
			idempotencyKey: z.string().optional(),
			cellsTotal: z.number().int().nonnegative().optional(),
		}),
		output: translationRunSchema,
		handler: ({ projectId: id, ...input }, { service, actor }) =>
			service.runs.start(actor, id, input),
	}),
	op({
		name: "get_run",
		description: "Get one run by id (status, progress, recorded budget).",
		input: z.object({ projectId, runId: z.string() }),
		output: translationRunSchema,
		handler: (a, { service, actor }) =>
			service.runs.get(actor, a.projectId, a.runId),
	}),
	op({
		name: "list_runs",
		description: "List a branch's runs (default `main`).",
		input: z.object({ projectId, branch: branchInput }),
		output: z.array(translationRunSchema),
		handler: (a, { service, actor }) =>
			service.runs.list(actor, a.projectId, a.branch),
	}),
	op({
		name: "finish_run",
		description:
			"Close a run with its outcome and recorded progress/budget (defaults to status `done`).",
		input: z.object({
			projectId,
			runId: z.string(),
			status: z.enum(["partial", "done", "failed", "canceled"]).optional(),
			cellsDone: z.number().int().nonnegative().optional(),
			cellsTotal: z.number().int().nonnegative().optional(),
			errors: z.array(z.string()).optional(),
			budgetSpent: z.number().nonnegative().optional(),
		}),
		output: translationRunSchema,
		handler: ({ projectId: id, runId, ...patch }, { service, actor }) =>
			service.runs.finish(actor, id, runId, patch),
	}),
	op({
		name: "cancel_run",
		description: "Cancel a run (records status `canceled`).",
		input: z.object({ projectId, runId: z.string() }),
		output: translationRunSchema,
		handler: (a, { service, actor }) =>
			service.runs.cancel(actor, a.projectId, a.runId),
	}),
];
