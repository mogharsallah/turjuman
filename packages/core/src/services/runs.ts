import type {
	Actor,
	RunStatus,
	RunTrigger,
	TranslationRun,
} from "@turjuman/schema";
import { MAIN_BRANCH_ID, newId, notFound } from "@turjuman/schema";
import { BaseService } from "./base.js";

export interface StartRunInput {
	branch?: string;
	trigger?: RunTrigger;
	/** `agent` (generated) or `branch:<id>` (a merge transporting accepted values). */
	valueSource?: string;
	idempotencyKey?: string;
	/** How many cells the run intends to touch (recorded for progress). */
	cellsTotal?: number;
}

export interface FinishRunInput {
	status?: RunStatus;
	cellsDone?: number;
	cellsTotal?: number;
	errors?: string[];
	/** Output tokens / cost spent (recorded, never enforced). */
	budgetSpent?: number;
}

/**
 * The agent write primitive as a recorded job. A run captures what an
 * external (MCP-driven) agent did to one branch — its trigger, value source,
 * progress and recorded budget. In this batch a run is bookkeeping (so `run.*`
 * webhooks fire and progress is observable); the controlled accept transition is
 * the repository's compare-and-swap, reached via `translations.accept`. Budget is
 * recorded, never enforced.
 */
export class RunService extends BaseService {
	async start(
		actor: Actor,
		projectId: string,
		input: StartRunInput = {},
	): Promise<TranslationRun> {
		await this.authorizeProject(actor, projectId, "translation.write");
		const now = new Date().toISOString();
		return this.repo.putRun({
			id: newId("run"),
			projectId,
			branchId: input.branch ?? MAIN_BRANCH_ID,
			trigger: input.trigger ?? "manual",
			valueSource: input.valueSource ?? "agent",
			status: "running",
			idempotencyKey: input.idempotencyKey,
			cellsTotal: input.cellsTotal ?? 0,
			cellsDone: 0,
			errors: [],
			startedAt: now,
		});
	}

	async get(
		actor: Actor,
		projectId: string,
		runId: string,
	): Promise<TranslationRun> {
		await this.authorizeProject(actor, projectId, "translation.read");
		const run = await this.repo.getRun(projectId, runId);
		if (!run) throw notFound(`Run ${runId} not found`);
		return run;
	}

	async list(
		actor: Actor,
		projectId: string,
		branch = MAIN_BRANCH_ID,
	): Promise<TranslationRun[]> {
		await this.authorizeProject(actor, projectId, "translation.read");
		return this.repo.listRunsByBranch(projectId, branch);
	}

	/** Record a run's terminal (or partial) outcome. Defaults to `done`. */
	async finish(
		actor: Actor,
		projectId: string,
		runId: string,
		patch: FinishRunInput = {},
	): Promise<TranslationRun> {
		await this.authorizeProject(actor, projectId, "translation.write");
		const run = await this.repo.getRun(projectId, runId);
		if (!run) throw notFound(`Run ${runId} not found`);
		return this.repo.putRun({
			...run,
			status: patch.status ?? "done",
			cellsDone: patch.cellsDone ?? run.cellsDone,
			cellsTotal: patch.cellsTotal ?? run.cellsTotal,
			errors: patch.errors ?? run.errors,
			budgetSpent: patch.budgetSpent ?? run.budgetSpent,
			finishedAt: new Date().toISOString(),
		});
	}

	async cancel(
		actor: Actor,
		projectId: string,
		runId: string,
	): Promise<TranslationRun> {
		await this.authorizeProject(actor, projectId, "translation.write");
		const run = await this.repo.getRun(projectId, runId);
		if (!run) throw notFound(`Run ${runId} not found`);
		return this.repo.putRun({
			...run,
			status: "canceled",
			finishedAt: new Date().toISOString(),
		});
	}
}
