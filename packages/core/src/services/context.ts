import type {
	Actor,
	Brief,
	CascadeTarget,
	ContextLifecycle,
	ContextOperator,
	ContextRule,
	ContextRuleKind,
	Project,
	ResolvedContext,
	Scope,
	TranslationKey,
} from "@turjuman/schema";
import {
	MAIN_BRANCH_ID,
	newId,
	notFound,
	resolveCascade,
} from "@turjuman/schema";
import type { RepositoryApi } from "../repository/index.js";
import { BaseService } from "./base.js";
import { resolveKeyRef } from "./keyref.js";
import type { NamespaceService } from "./namespaces.js";

/** A scope coordinate as supplied by a caller — the project is implied. */
export interface ScopeInput {
	namespaceId?: string;
	keyId?: string;
	locale?: string;
}

export interface CreateContextRuleInput {
	scope?: ScopeInput;
	kind: ContextRuleKind;
	operator?: ContextOperator;
	payload?: Record<string, unknown>;
	hard?: boolean;
}

export interface UpdateContextRuleInput {
	payload?: Record<string, unknown>;
	operator?: ContextOperator;
	hard?: boolean;
	lifecycle?: ContextLifecycle;
}

export interface KeyRefOpts {
	namespace?: string;
	branch?: string;
}

/** The merge operator each rule kind defaults to when the caller omits one. */
const DEFAULT_OPERATOR: Record<ContextRuleKind, ContextOperator> = {
	voice: "override",
	length: "override",
	placeholdersRequired: "override",
	format: "override",
	compliance: "restrict",
};

/**
 * The context layer — the part of the model where product value compounds.
 * Owns scoped {@link ContextRule}s and the **resolver**: it folds every in-scope
 * rule, glossary term, and example down the cascade ({@link resolveCascade}) into
 * the briefing the agent translates against. Any scoped context write bumps the
 * project's `contextRevision` and marks dependent cells `stale` ({@link
 * noteContextChange}) — the glossary and example services route their writes
 * through it too, so the staleness fan-out is uniform.
 */
export class ContextService extends BaseService {
	constructor(
		repo: RepositoryApi,
		private readonly namespaces: NamespaceService,
	) {
		super(repo);
	}

	async listRules(actor: Actor, projectId: string): Promise<ContextRule[]> {
		await this.authorizeProject(actor, projectId, "glossary.read");
		return this.repo.listContextRules(projectId);
	}

	async getRule(
		actor: Actor,
		projectId: string,
		id: string,
	): Promise<ContextRule> {
		await this.authorizeProject(actor, projectId, "glossary.read");
		const rule = await this.repo.getContextRule(projectId, id);
		if (!rule) throw notFound(`Context rule ${id} not found`);
		return rule;
	}

	async createRule(
		actor: Actor,
		projectId: string,
		input: CreateContextRuleInput,
	): Promise<ContextRule> {
		await this.authorizeProject(actor, projectId, "glossary.manage");
		const scope: Scope = { projectId, ...input.scope };
		const now = new Date().toISOString();
		const saved = await this.repo.putContextRule({
			id: newId("ctx"),
			projectId,
			scope,
			kind: input.kind,
			operator: input.operator ?? DEFAULT_OPERATOR[input.kind],
			payload: input.payload ?? {},
			hard: input.hard,
			lifecycle: "active",
			createdBy: actor.userId,
			createdAt: now,
			updatedAt: now,
		});
		await this.noteContextChange(projectId, scope);
		return saved;
	}

	async updateRule(
		actor: Actor,
		projectId: string,
		id: string,
		patch: UpdateContextRuleInput,
	): Promise<ContextRule> {
		await this.authorizeProject(actor, projectId, "glossary.manage");
		const existing = await this.repo.getContextRule(projectId, id);
		if (!existing) throw notFound(`Context rule ${id} not found`);
		const saved = await this.repo.putContextRule({
			...existing,
			payload: patch.payload ?? existing.payload,
			operator: patch.operator ?? existing.operator,
			hard: patch.hard ?? existing.hard,
			lifecycle: patch.lifecycle ?? existing.lifecycle,
			updatedAt: new Date().toISOString(),
		});
		await this.noteContextChange(projectId, existing.scope);
		return saved;
	}

	async deleteRule(actor: Actor, projectId: string, id: string): Promise<void> {
		await this.authorizeProject(actor, projectId, "glossary.manage");
		const existing = await this.repo.getContextRule(projectId, id);
		if (!existing) return;
		await this.repo.deleteContextRule(projectId, id);
		await this.noteContextChange(projectId, existing.scope);
	}

	/** Resolve the full context cascade for one `key × locale` (read). */
	async resolve(
		actor: Actor,
		projectId: string,
		code: string,
		name: string,
		opts: KeyRefOpts = {},
	): Promise<ResolvedContext> {
		const { target } = await this.loadTarget(
			actor,
			projectId,
			code,
			name,
			opts,
		);
		const [rules, glossary, examples] = await Promise.all([
			this.repo.listContextRules(projectId),
			this.repo.listGlossary(projectId),
			this.repo.listExamples(projectId),
		]);
		return resolveCascade({ ...target, rules, glossary, examples });
	}

	/** The agent briefing for one `key × locale`: the key, its base value, and the
	 * resolved cascade — everything the agent needs to translate it well. */
	async brief(
		actor: Actor,
		projectId: string,
		code: string,
		name: string,
		opts: KeyRefOpts = {},
	): Promise<Brief> {
		const { project, key, branch, target } = await this.loadTarget(
			actor,
			projectId,
			code,
			name,
			opts,
		);
		const [rules, glossary, examples, baseCell] = await Promise.all([
			this.repo.listContextRules(projectId),
			this.repo.listGlossary(projectId),
			this.repo.listExamples(projectId),
			this.repo.getCell(projectId, branch, key.id, project.baseLocale),
		]);
		return {
			key,
			locale: code,
			baseValue: baseCell?.value,
			context: resolveCascade({ ...target, rules, glossary, examples }),
		};
	}

	// ---- internal (trusted; the caller authorizes) ----------------------------

	/**
	 * Record a scoped context change: bump the project's `contextRevision` and mark
	 * the in-scope cells `stale` so they re-enter the router. A key-scoped change
	 * touches one key; a namespace-scoped change every key in that namespace; a
	 * project-scoped change every active key. Always fans out on `main` (context is
	 * branch-free). Called by the context, glossary, and example writes.
	 */
	async noteContextChange(projectId: string, scope: Scope): Promise<void> {
		await this.repo.bumpContextRevision(projectId);
		const branch = MAIN_BRANCH_ID;
		if (scope.keyId) {
			await this.repo.markCellsStaleByKey(projectId, branch, scope.keyId);
			return;
		}
		const keys = (await this.repo.listKeyDefs(projectId, branch)).filter(
			(k) =>
				k.state !== "deprecated" &&
				(scope.namespaceId ? k.namespaceId === scope.namespaceId : true),
		);
		for (const k of keys)
			await this.repo.markCellsStaleByKey(projectId, branch, k.id);
	}

	private async loadTarget(
		actor: Actor,
		projectId: string,
		code: string,
		name: string,
		opts: KeyRefOpts,
	): Promise<{
		project: Project;
		key: TranslationKey;
		branch: string;
		target: CascadeTarget;
	}> {
		const { project } = await this.authorizeProject(
			actor,
			projectId,
			"translation.read",
		);
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
		return {
			project,
			key,
			branch,
			target: {
				projectId,
				namespaceId: key.namespaceId,
				keyId: key.id,
				locale: code,
			},
		};
	}
}
