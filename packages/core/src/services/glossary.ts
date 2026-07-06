import type { Actor, GlossaryTerm, Scope } from "@turjuman/schema";
import { newId, notFound, requireText } from "@turjuman/schema";
import type { RepositoryApi } from "../repository/index.js";
import { BaseService } from "./base.js";
import type { ContextService } from "./context.js";
import type { AddGlossaryTermInput, UpdateGlossaryTermInput } from "./types.js";

/**
 * Glossary terms — a context entity that merges by **union** across the cascade.
 * Each term carries a `Scope` (absent = project-wide) and a context `lifecycle`;
 * writes route through the context fan-out ({@link ContextService.noteContextChange})
 * so changing terminology stales the dependents that resolve through that scope.
 */
export class GlossaryService extends BaseService {
	constructor(
		repo: RepositoryApi,
		private readonly context: ContextService,
	) {
		super(repo);
	}

	async list(actor: Actor, projectId: string): Promise<GlossaryTerm[]> {
		await this.authorizeProject(actor, projectId, "glossary.read");
		return this.repo.listGlossary(projectId);
	}

	async add(
		actor: Actor,
		projectId: string,
		input: AddGlossaryTermInput,
	): Promise<GlossaryTerm> {
		await this.authorizeProject(actor, projectId, "glossary.manage");
		const scope: Scope | undefined = input.scope
			? { ...input.scope, projectId }
			: undefined;
		const now = new Date().toISOString();
		const saved = await this.repo.putGlossaryTerm({
			projectId,
			id: newId("term"),
			scope,
			term: requireText(input.term, "term"),
			translations: input.translations ?? {},
			caseSensitive: input.caseSensitive ?? false,
			doNotTranslate: input.doNotTranslate ?? false,
			notes: input.notes,
			lifecycle: "active",
			createdAt: now,
			updatedAt: now,
		});
		await this.context.noteContextChange(projectId, scope ?? { projectId });
		return saved;
	}

	async update(
		actor: Actor,
		projectId: string,
		termId: string,
		patch: UpdateGlossaryTermInput,
	): Promise<GlossaryTerm> {
		await this.authorizeProject(actor, projectId, "glossary.manage");
		const existing = await this.repo.getGlossaryTerm(projectId, termId);
		if (!existing) throw notFound("Glossary term not found");
		const scope = patch.scope ? { ...patch.scope, projectId } : existing.scope;
		const saved = await this.repo.putGlossaryTerm({
			...existing,
			scope,
			term:
				patch.term !== undefined
					? requireText(patch.term, "term")
					: existing.term,
			translations: patch.translations ?? existing.translations,
			caseSensitive: patch.caseSensitive ?? existing.caseSensitive,
			doNotTranslate: patch.doNotTranslate ?? existing.doNotTranslate,
			notes: patch.notes ?? existing.notes,
			lifecycle: patch.lifecycle ?? existing.lifecycle,
			updatedAt: new Date().toISOString(),
		});
		await this.context.noteContextChange(projectId, scope ?? { projectId });
		return saved;
	}

	async remove(actor: Actor, projectId: string, termId: string): Promise<void> {
		await this.authorizeProject(actor, projectId, "glossary.manage");
		const existing = await this.repo.getGlossaryTerm(projectId, termId);
		if (!existing) return;
		await this.repo.deleteGlossaryTerm(projectId, termId);
		await this.context.noteContextChange(
			projectId,
			existing.scope ?? { projectId },
		);
	}
}
