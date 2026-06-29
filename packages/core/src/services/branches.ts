import type { Actor, Branch } from "@turjuman/schema";
import { MAIN_BRANCH_ID, notFound } from "@turjuman/schema";
import { BaseService } from "./base.js";

/**
 * Branches: named, copy-on-write lines of work over a project's keys and
 * translations. `main` always exists and is the safe root. In this batch only
 * `main` is created and used; `create`/`merge` (diverging and reconciling
 * branches) arrive in a later batch. Reads of an unwritten key/cell on a child
 * branch fall through to the parent in the repository.
 */
export class BranchService extends BaseService {
	/** Create the root `main` branch if it does not yet exist (idempotent). Called
	 * when a project is created so every project has a branch from day one. */
	async ensureMain(projectId: string, createdBy: string): Promise<Branch> {
		const existing = await this.repo.getBranch(projectId, MAIN_BRANCH_ID);
		if (existing) return existing;
		return this.repo.putBranch({
			id: MAIN_BRANCH_ID,
			projectId,
			name: MAIN_BRANCH_ID,
			parentBranchId: null,
			status: "open",
			createdBy,
			createdAt: new Date().toISOString(),
		});
	}

	async list(actor: Actor, projectId: string): Promise<Branch[]> {
		await this.authorizeProject(actor, projectId, "project.read");
		return this.repo.listBranches(projectId);
	}

	async get(
		actor: Actor,
		projectId: string,
		branchId: string,
	): Promise<Branch> {
		await this.authorizeProject(actor, projectId, "project.read");
		const branch = await this.repo.getBranch(projectId, branchId);
		if (!branch) throw notFound(`Branch ${branchId} not found`);
		return branch;
	}

	/** Validate that a branch ref exists, returning its id. Used by the write
	 * services to resolve an optional `branch` argument (default `main`). */
	async requireBranch(projectId: string, branchId: string): Promise<string> {
		if (!(await this.repo.getBranch(projectId, branchId)))
			throw notFound(`Branch ${branchId} not found`);
		return branchId;
	}
}
