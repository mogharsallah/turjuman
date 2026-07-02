import type { Actor, Branch, Escalation, MergeResult } from "@turjuman/schema";
import {
	MAIN_BRANCH_ID,
	newId,
	notFound,
	requireText,
	validation,
} from "@turjuman/schema";
import { BaseService } from "./base.js";

/** Create a branch off a parent (defaults to `main`). */
export interface CreateBranchInput {
	name: string;
	/** Parent to fork from; defaults to `main`. */
	from?: string;
}

/**
 * Branches: named, copy-on-write lines of work over a project's keys and
 * translations. `main` always exists (`parentBranchId = null`) and is the safe
 * root; nothing experimental touches it until a deliberate merge. A branch stores
 * only the keys/cells it actually writes — every unwritten read falls through to
 * the parent (handled in the repository), so a feature branch is a handful of
 * rows, not a clone.
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

	/**
	 * Fork a new branch off a parent (default `main`). `forkPoint` records the
	 * fork instant — the merge baseline: a cell the parent advances past it is what
	 * later surfaces as a merge conflict. The branch owns nothing yet; all reads
	 * fall through to the parent until it writes.
	 */
	async create(
		actor: Actor,
		projectId: string,
		input: CreateBranchInput,
	): Promise<Branch> {
		await this.authorizeProject(actor, projectId, "translation.write");
		const parentId = input.from ?? MAIN_BRANCH_ID;
		if (!(await this.repo.getBranch(projectId, parentId)))
			throw notFound(`Branch ${parentId} not found`);
		const now = new Date().toISOString();
		return this.repo.putBranch({
			id: newId("br"),
			projectId,
			name: requireText(input.name, "name"),
			parentBranchId: parentId,
			forkPoint: now,
			status: "open",
			createdBy: actor.userId,
			createdAt: now,
		});
	}

	/**
	 * Merge a branch into its parent — a `TranslationRun{trigger:merge}` that
	 * *transports* the child's accepted values instead of generating them, so it
	 * spends no budget. Each accepted child cell is applied onto the parent unless
	 * the parent advanced that cell past the `forkPoint` and to a different value —
	 * a two-sided change, surfaced as an **escalation** rather than a silent
	 * overwrite. Branch-introduced keys (defs the child owns and the parent lacks)
	 * come along too. The branch is marked `merged`; the run's `errors` note any
	 * key that couldn't transport.
	 */
	async merge(
		actor: Actor,
		projectId: string,
		childBranchId: string,
	): Promise<MergeResult> {
		await this.authorizeProject(actor, projectId, "translation.review");
		const child = await this.repo.getBranch(projectId, childBranchId);
		if (!child) throw notFound(`Branch ${childBranchId} not found`);
		if (!child.parentBranchId)
			throw validation("The main branch cannot be merged");
		const parentId = child.parentBranchId;
		const forkPoint = child.forkPoint ?? child.createdAt;
		const now = new Date().toISOString();
		const errors: string[] = [];

		let run = await this.repo.putRun({
			id: newId("run"),
			projectId,
			branchId: parentId,
			trigger: "merge",
			valueSource: `branch:${childBranchId}`,
			status: "running",
			cellsTotal: 0,
			cellsDone: 0,
			errors: [],
			budgetSpent: 0,
			startedAt: now,
		});

		// 1. Transport branch-introduced keys (defs the child owns, parent lacks).
		for (const k of await this.repo.listKeyDefs(projectId, childBranchId)) {
			if (await this.repo.getKeyDef(projectId, parentId, k.id)) continue;
			try {
				await this.repo.createKeyDef(parentId, { ...k });
			} catch {
				errors.push(`Key "${k.name}" conflicts on ${parentId}; not merged.`);
			}
		}

		// 2. Transport the child's accepted cells; a parent that moved past the
		// forkPoint and differs is a conflict → escalation.
		const conflicts: Escalation[] = [];
		let merged = 0;
		for (const locale of await this.repo.listLocales(projectId)) {
			const code = locale.code;
			const childCells = await this.repo.listCellsByLocale(
				projectId,
				childBranchId,
				code,
			);
			const parentOwn = new Map(
				(await this.repo.listCellsByLocale(projectId, parentId, code)).map(
					(c) => [c.keyId, c],
				),
			);
			for (const c of childCells) {
				if (c.lifecycle !== "accepted" || c.value.trim() === "") continue;
				const p = parentOwn.get(c.keyId);
				if (p && p.updatedAt > forkPoint && p.value !== c.value) {
					conflicts.push(
						await this.repo.putEscalation({
							id: newId("esc"),
							projectId,
							branchId: parentId,
							keyId: c.keyId,
							locale: code,
							reason: `Merge conflict: "${child.name}" and "${parentId}" both changed this string`,
							status: "open",
							openedAt: now,
						}),
					);
					continue;
				}
				const parentKey = await this.repo.getKeyDef(
					projectId,
					parentId,
					c.keyId,
				);
				// acceptCell advances an existing cell; when the parent never had this
				// cell, create it first so the transported value still gets a version.
				const base =
					p ??
					(await this.repo.putCell({
						projectId,
						branchId: parentId,
						keyId: c.keyId,
						locale: code,
						value: c.value,
						lifecycle: "proposed",
						stale: false,
						sourceRef: parentKey?.sourceRevision,
						origin: c.origin,
						updatedBy: actor.userId,
						updatedAt: now,
					}));
				await this.repo.acceptCell({
					projectId,
					branchId: parentId,
					keyId: c.keyId,
					locale: code,
					value: c.value,
					origin: c.origin,
					sourceRevision: parentKey?.sourceRevision,
					runRef: run.id,
					expectedHead: base.head,
					updatedBy: actor.userId,
				});
				merged++;
			}
		}

		// 3. Close the branch and finish the run (a merge spends no budget).
		await this.repo.putBranch({ ...child, status: "merged", mergedAt: now });
		run = await this.repo.putRun({
			...run,
			status: conflicts.length > 0 ? "partial" : "done",
			cellsTotal: merged + conflicts.length,
			cellsDone: merged,
			errors,
			finishedAt: new Date().toISOString(),
		});
		return { run, merged, conflicts };
	}

	/** Validate that a branch ref exists, returning its id. Used by the write
	 * services to resolve an optional `branch` argument (default `main`). */
	async requireBranch(projectId: string, branchId: string): Promise<string> {
		if (!(await this.repo.getBranch(projectId, branchId)))
			throw notFound(`Branch ${branchId} not found`);
		return branchId;
	}
}
