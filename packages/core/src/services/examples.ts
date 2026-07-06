import type {
	Actor,
	Example,
	ExampleQuality,
	Scope,
	TranslationOrigin,
} from "@turjuman/schema";
import {
	MAIN_BRANCH_ID,
	newId,
	rankExamples,
	requireText,
} from "@turjuman/schema";
import type { RepositoryApi } from "../repository/index.js";
import { BaseService } from "./base.js";
import type { ContextService, KeyRefOpts, ScopeInput } from "./context.js";
import { resolveKeyRef } from "./keyref.js";
import type { NamespaceService } from "./namespaces.js";

export interface AddExampleInput {
	scope?: ScopeInput;
	/** Target locale the `targetText` is written in. */
	locale: string;
	sourceText: string;
	targetText: string;
	quality?: ExampleQuality;
	origin?: TranslationOrigin;
}

/**
 * The translation-memory / few-shot corpus. Replaces the deleted on-the-fly
 * `tm.ts`: examples are stored, scoped, and retrieved **deterministically** by
 * scope-proximity + quality + recency (no embeddings, per the no-in-app-model
 * constraint) via the cascade's {@link rankExamples}. Adds/removes route through
 * the context fan-out so changing the corpus stales dependents.
 */
export class ExampleService extends BaseService {
	constructor(
		repo: RepositoryApi,
		private readonly context: ContextService,
		private readonly namespaces: NamespaceService,
	) {
		super(repo);
	}

	async list(actor: Actor, projectId: string): Promise<Example[]> {
		await this.authorizeProject(actor, projectId, "glossary.read");
		return this.repo.listExamples(projectId);
	}

	async add(
		actor: Actor,
		projectId: string,
		input: AddExampleInput,
	): Promise<Example> {
		await this.authorizeProject(actor, projectId, "glossary.manage");
		await this.requireLocaleExists(projectId, input.locale);
		const scope: Scope = { projectId, ...input.scope };
		const now = new Date().toISOString();
		const saved = await this.repo.putExample({
			id: newId("ex"),
			projectId,
			scope,
			locale: input.locale,
			sourceText: requireText(input.sourceText, "sourceText"),
			targetText: requireText(input.targetText, "targetText"),
			quality: input.quality ?? "accepted",
			origin: input.origin,
			lifecycle: "active",
			createdAt: now,
			updatedAt: now,
		});
		await this.context.noteContextChange(projectId, scope);
		return saved;
	}

	async remove(actor: Actor, projectId: string, id: string): Promise<void> {
		await this.authorizeProject(actor, projectId, "glossary.manage");
		const existing = await this.repo.getExample(projectId, id);
		if (!existing) return;
		await this.repo.deleteExample(projectId, id);
		await this.context.noteContextChange(projectId, existing.scope);
	}

	/** Deterministic retrieval for one `key × locale`: the in-scope, active,
	 * target-locale examples ranked by proximity → quality → recency. */
	async find(
		actor: Actor,
		projectId: string,
		code: string,
		name: string,
		opts: KeyRefOpts = {},
	): Promise<Example[]> {
		await this.authorizeProject(actor, projectId, "translation.read");
		await this.requireLocaleExists(projectId, code);
		const branch = opts.branch ?? MAIN_BRANCH_ID;
		const { key } = await resolveKeyRef(
			this.repo,
			this.namespaces,
			projectId,
			branch,
			name,
			opts.namespace,
		);
		const examples = await this.repo.listExamples(projectId);
		return rankExamples(examples, {
			projectId,
			namespaceId: key.namespaceId,
			keyId: key.id,
			locale: code,
		});
	}
}
