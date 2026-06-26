import type { Actor, GlossaryTerm } from "@turjuman/schema";
import { newId, notFound, requireText } from "@turjuman/schema";
import { BaseService } from "./base.js";
import type { AddGlossaryTermInput, UpdateGlossaryTermInput } from "./types.js";

export class GlossaryService extends BaseService {
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
		const now = new Date().toISOString();
		const term: GlossaryTerm = {
			projectId,
			id: newId("term"),
			term: requireText(input.term, "term"),
			translations: input.translations ?? {},
			caseSensitive: input.caseSensitive ?? false,
			doNotTranslate: input.doNotTranslate ?? false,
			notes: input.notes,
			createdAt: now,
			updatedAt: now,
		};
		return this.repo.putGlossaryTerm(term);
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
		const updated: GlossaryTerm = {
			...existing,
			term:
				patch.term !== undefined
					? requireText(patch.term, "term")
					: existing.term,
			translations: patch.translations ?? existing.translations,
			caseSensitive: patch.caseSensitive ?? existing.caseSensitive,
			doNotTranslate: patch.doNotTranslate ?? existing.doNotTranslate,
			notes: patch.notes ?? existing.notes,
			updatedAt: new Date().toISOString(),
		};
		return this.repo.putGlossaryTerm(updated);
	}

	async remove(actor: Actor, projectId: string, termId: string): Promise<void> {
		await this.authorizeProject(actor, projectId, "glossary.manage");
		await this.repo.deleteGlossaryTerm(projectId, termId);
	}
}
