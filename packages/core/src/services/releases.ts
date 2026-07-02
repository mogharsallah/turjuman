import type { Actor, Release } from "@turjuman/schema";
import { MAIN_BRANCH_ID, newId, notFound, requireText } from "@turjuman/schema";
import { BaseService } from "./base.js";

export interface CreateReleaseInput {
	label: string;
	/** Branch to pin; defaults to `main`. */
	branch?: string;
	/** Locales to include; defaults to every project locale. */
	locales?: string[];
}

/**
 * Releases: immutable shipped snapshots. Creating one pins a branch and
 * materializes its resolved accepted view (own cells + fall-through) into a fixed
 * list of `(keyId, locale) → versionRef` entries. "Live" is the latest Release,
 * so cutting a new one supersedes the prior `open` release **on the same branch**
 * (a different branch's release stays open — that is how A/B ships two lines). A
 * release never changes after creation.
 */
export class ReleaseService extends BaseService {
	async create(
		actor: Actor,
		projectId: string,
		input: CreateReleaseInput,
	): Promise<Release> {
		await this.authorizeProject(actor, projectId, "translation.write");
		const branch = input.branch ?? MAIN_BRANCH_ID;
		if (!(await this.repo.getBranch(projectId, branch)))
			throw notFound(`Branch ${branch} not found`);
		const allCodes = (await this.repo.listLocales(projectId)).map(
			(l) => l.code,
		);
		const locales =
			input.locales && input.locales.length > 0 ? input.locales : allCodes;
		const keys = (
			await this.repo.listKeyDefsResolved(projectId, branch)
		).filter((k) => k.state !== "deprecated");
		const entries: Release["entries"] = [];
		for (const code of locales)
			for (const key of keys) {
				const cell = await this.repo.getCell(projectId, branch, key.id, code);
				// Pin only accepted cells (those with a head version): a release ships
				// approved values, never in-progress drafts.
				if (cell?.head !== undefined)
					entries.push({ keyId: key.id, locale: code, versionRef: cell.head });
			}
		const now = new Date().toISOString();
		const release: Release = {
			id: newId("rel"),
			projectId,
			branchId: branch,
			label: requireText(input.label, "label"),
			locales,
			status: "open",
			createdBy: actor.userId,
			createdAt: now,
			entries,
		};
		// The newest release on a branch is live; supersede the prior open one so
		// "latest" stays unambiguous.
		for (const prior of await this.repo.listReleases(projectId))
			if (prior.branchId === branch && prior.status === "open")
				await this.repo.setReleaseStatus(projectId, prior.id, "superseded");
		return this.repo.putRelease(release);
	}

	async list(actor: Actor, projectId: string): Promise<Release[]> {
		await this.authorizeProject(actor, projectId, "translation.read");
		return this.repo.listReleases(projectId);
	}

	async get(
		actor: Actor,
		projectId: string,
		releaseId: string,
	): Promise<Release> {
		await this.authorizeProject(actor, projectId, "translation.read");
		const release = await this.repo.getRelease(projectId, releaseId);
		if (!release) throw notFound(`Release ${releaseId} not found`);
		return release;
	}
}
