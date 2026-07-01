import type { Actor, FieldReport } from "@turjuman/schema";
import {
	conflict,
	MAIN_BRANCH_ID,
	newId,
	notFound,
	requireText,
} from "@turjuman/schema";
import type { RepositoryApi } from "../repository/index.js";
import { BaseService } from "./base.js";
import type { ContextService } from "./context.js";
import { resolveKeyRef } from "./keyref.js";
import type { NamespaceService } from "./namespaces.js";

export interface FileFieldReportInput {
	locale: string;
	name: string;
	namespace?: string;
	branch?: string;
	/** The Release that was live when the bad string shipped (provenance). */
	releaseRef?: string;
	description: string;
}

export interface ResolveFieldReportInput {
	/** Spawn a gold Example (base → the current accepted value) from the fix. */
	spawnExample?: boolean;
	/** Spawn a key-scoped glossary term from the correction. */
	spawnGlossary?: { term: string; translations?: Record<string, string> };
}

/**
 * Field reports: production saying "this shipped string is wrong" — the one fact
 * the in-loop agent can't know from its own context. Filing **reopens** the
 * targeted cell (`accepted → proposed` + `stale`), so it re-enters the router and
 * a normal run fixes it. Resolving may **spawn an Example/GlossaryTerm** from the
 * correction, so the fix compounds into reusable context (the same judgment →
 * context → fan-out an escalation runs). No corroboration math — an API-key-gated
 * tool has no anonymous mob to guard against.
 */
export class FieldReportService extends BaseService {
	constructor(
		repo: RepositoryApi,
		private readonly namespaces: NamespaceService,
		private readonly context: ContextService,
	) {
		super(repo);
	}

	async file(
		actor: Actor,
		projectId: string,
		input: FileFieldReportInput,
	): Promise<FieldReport> {
		await this.authorizeProject(actor, projectId, "translation.write");
		await this.requireLocaleExists(projectId, input.locale);
		const branch = input.branch ?? MAIN_BRANCH_ID;
		const { keyId } = await resolveKeyRef(
			this.repo,
			this.namespaces,
			projectId,
			branch,
			input.name,
			input.namespace,
		);
		const now = new Date().toISOString();
		// Reopen an accepted cell (accepted → proposed + stale) so the fix re-enters
		// the router; a cell that is not accepted is left as-is.
		const cell = await this.repo.getCell(
			projectId,
			branch,
			keyId,
			input.locale,
		);
		if (cell && cell.lifecycle === "accepted")
			await this.repo.putCell({
				...cell,
				lifecycle: "proposed",
				stale: true,
				updatedBy: actor.userId,
				updatedAt: now,
			});
		return this.repo.putFieldReport({
			id: newId("fr"),
			projectId,
			branchId: branch,
			keyId,
			locale: input.locale,
			releaseRef: input.releaseRef,
			description: requireText(input.description, "description"),
			status: "open",
			reportedBy: actor.userId,
			createdAt: now,
		});
	}

	async list(actor: Actor, projectId: string): Promise<FieldReport[]> {
		await this.authorizeProject(actor, projectId, "translation.read");
		return this.repo.listFieldReports(projectId);
	}

	/**
	 * Resolve a field report: close it and optionally spawn context from the fix.
	 * The corrected value is the cell's current value (the fix a run has since
	 * applied); a spawned Example/GlossaryTerm makes that correction reusable and
	 * fans out staleness like any other context write.
	 */
	async resolve(
		actor: Actor,
		projectId: string,
		reportId: string,
		input: ResolveFieldReportInput = {},
	): Promise<FieldReport> {
		const { project } = await this.authorizeProject(
			actor,
			projectId,
			"translation.review",
		);
		const report = await this.repo.getFieldReport(projectId, reportId);
		if (!report) throw notFound(`Field report ${reportId} not found`);
		if (report.status === "resolved")
			throw conflict("Field report already resolved");
		const { branchId, keyId, locale } = report;
		const now = new Date().toISOString();
		const scope = { projectId, keyId };
		const resolution: FieldReport["resolution"] = {};
		if (input.spawnExample) {
			const [cell, base] = await Promise.all([
				this.repo.getCell(projectId, branchId, keyId, locale),
				this.repo.getCell(projectId, branchId, keyId, project.baseLocale),
			]);
			const ex = await this.repo.putExample({
				id: newId("ex"),
				projectId,
				scope,
				locale,
				sourceText: base?.value ?? "",
				targetText: cell?.value ?? "",
				quality: "gold",
				origin: "human",
				lifecycle: "active",
				createdAt: now,
				updatedAt: now,
			});
			resolution.spawnedExampleRef = ex.id;
		}
		if (input.spawnGlossary) {
			const term = await this.repo.putGlossaryTerm({
				projectId,
				id: newId("term"),
				scope,
				term: requireText(input.spawnGlossary.term, "term"),
				translations: input.spawnGlossary.translations ?? {},
				caseSensitive: false,
				doNotTranslate: false,
				lifecycle: "active",
				createdAt: now,
				updatedAt: now,
			});
			resolution.spawnedGlossaryRef = term.id;
		}
		const saved = await this.repo.putFieldReport({
			...report,
			status: "resolved",
			resolvedAt: now,
			resolution,
		});
		if (input.spawnExample || input.spawnGlossary)
			await this.context.noteContextChange(projectId, scope);
		return saved;
	}
}
