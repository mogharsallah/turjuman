import type { Actor, Escalation, EscalationStatus } from "@turjuman/schema";
import {
	conflict,
	forbidden,
	MAIN_BRANCH_ID,
	newId,
	notFound,
	requireText,
	validation,
} from "@turjuman/schema";
import type { RepositoryApi } from "../repository/index.js";
import { BaseService } from "./base.js";
import type { ContextService } from "./context.js";
import { resolveKeyRef } from "./keyref.js";
import type { NamespaceService } from "./namespaces.js";

export interface OpenEscalationInput {
	namespace?: string;
	branch?: string;
	reason: string;
	assigneeUserId?: string;
}

export interface ResolveEscalationInput {
	/** The value to commit; defaults to the cell's current draft. */
	value?: string;
	/** Spawn a gold Example (base → chosen value) so the decision is reusable. */
	spawnExample?: boolean;
	/** Spawn a key-scoped glossary term from the human's decision. */
	spawnGlossary?: { term: string; translations?: Record<string, string> };
}

/**
 * The review router's human terminal exit. Opening flips a cell to `escalated`
 * (the lifecycle is the whole verdict); claiming is a compare-and-swap so two
 * reviewers can't both take it; resolving accepts the chosen value (a human
 * accept, always permitted) and may **spawn an Example/GlossaryTerm** so the
 * decision compounds into reusable context rather than a dead-end approval.
 */
export class EscalationService extends BaseService {
	constructor(
		repo: RepositoryApi,
		private readonly namespaces: NamespaceService,
		private readonly context: ContextService,
	) {
		super(repo);
	}

	async open(
		actor: Actor,
		projectId: string,
		code: string,
		name: string,
		input: OpenEscalationInput,
	): Promise<Escalation> {
		await this.authorizeProject(actor, projectId, "translation.review");
		await this.requireLocaleExists(projectId, code);
		const branch = input.branch ?? MAIN_BRANCH_ID;
		const { keyId } = await resolveKeyRef(
			this.repo,
			this.namespaces,
			projectId,
			branch,
			name,
			input.namespace,
		);
		// Materialize an inherited cell onto this branch so the escalation flips the
		// branch's own cell, not the shared parent's (cross-branch contamination).
		const cell = await this.repo.materializeCell(
			projectId,
			branch,
			keyId,
			code,
		);
		if (!cell) throw notFound(`No ${code} translation for ${name}`);
		const now = new Date().toISOString();
		// The lifecycle is the verdict: flip the cell to `escalated`.
		await this.repo.putCell({
			...cell,
			lifecycle: "escalated",
			updatedBy: actor.userId,
			updatedAt: now,
		});
		return this.repo.putEscalation({
			id: newId("esc"),
			projectId,
			branchId: branch,
			keyId,
			locale: code,
			reason: requireText(input.reason, "reason"),
			assigneeUserId: input.assigneeUserId,
			status: "open",
			openedAt: now,
		});
	}

	async list(
		actor: Actor,
		projectId: string,
		opts: { status?: EscalationStatus } = {},
	): Promise<Escalation[]> {
		await this.authorizeProject(actor, projectId, "translation.read");
		const all = await this.repo.listEscalations(projectId);
		return opts.status ? all.filter((e) => e.status === opts.status) : all;
	}

	async get(actor: Actor, projectId: string, id: string): Promise<Escalation> {
		await this.authorizeProject(actor, projectId, "translation.read");
		const esc = await this.repo.getEscalation(projectId, id);
		if (!esc) throw notFound(`Escalation ${id} not found`);
		return esc;
	}

	/** Claim an open escalation (compare-and-swap on `claimedBy`). */
	async claim(
		actor: Actor,
		projectId: string,
		id: string,
	): Promise<Escalation> {
		await this.authorizeProject(actor, projectId, "translation.review");
		const esc = await this.repo.getEscalation(projectId, id);
		if (!esc) throw notFound(`Escalation ${id} not found`);
		return this.repo.claimEscalation(
			projectId,
			id,
			actor.userId,
			new Date().toISOString(),
		);
	}

	/** Resolve an escalation: accept the chosen value and optionally spawn context. */
	async resolve(
		actor: Actor,
		projectId: string,
		id: string,
		input: ResolveEscalationInput = {},
	): Promise<Escalation> {
		const { project } = await this.authorizeProject(
			actor,
			projectId,
			"translation.review",
		);
		// Resolving commits the chosen value as a human accept; under
		// requireHumanAccept an agent key may not do so (gated on the principal).
		if (project.requireHumanAccept && actor.principal === "agent")
			throw forbidden(
				"This project requires a human to accept; an agent key cannot resolve an escalation.",
			);
		const esc = await this.repo.getEscalation(projectId, id);
		if (!esc) throw notFound(`Escalation ${id} not found`);
		if (esc.status === "resolved")
			throw conflict("Escalation already resolved");
		const { branchId, keyId, locale } = esc;
		// Materialize so the accept CAS targets a branch-owned cell (an escalation on
		// a child branch may point at a cell still inherited from the parent).
		const [cell, key] = await Promise.all([
			this.repo.materializeCell(projectId, branchId, keyId, locale),
			this.repo.getKeyDef(projectId, branchId, keyId),
		]);
		if (!cell || !key) throw notFound("Escalated translation no longer exists");
		const value = (input.value ?? cell.value).trim();
		if (value === "") throw validation("Cannot resolve with an empty value");
		// A human accept (no run attribution) — always permitted, even under
		// requireHumanAccept. CAS on the cell's head guards concurrent accepts.
		await this.repo.acceptCell({
			projectId,
			branchId,
			keyId,
			locale,
			value,
			origin: "human",
			sourceRevision: key.sourceRevision,
			acceptedBy: actor.userId,
			expectedHead: cell.head,
			updatedBy: actor.userId,
		});

		const now = new Date().toISOString();
		const scope = { projectId, keyId };
		const resolution: Escalation["resolution"] = { valueChosen: value };
		const spawned = input.spawnExample || input.spawnGlossary;
		if (spawned) {
			// The example ships base → chosen value; the base is only read when an
			// example is spawned.
			const base = input.spawnExample
				? await this.repo.getCell(
						projectId,
						branchId,
						keyId,
						project.baseLocale,
					)
				: undefined;
			Object.assign(
				resolution,
				await this.spawnDecisionContext({
					scope,
					locale,
					now,
					sourceText: base?.value ?? "",
					targetText: value,
					spawnExample: input.spawnExample,
					spawnGlossary: input.spawnGlossary,
				}),
			);
		}
		const saved = await this.repo.putEscalation({
			...esc,
			status: "resolved",
			resolvedAt: now,
			resolution,
		});
		// A spawned Example/GlossaryTerm is a context change → fan out staleness, but
		// exclude the cell this resolution just accepted so it isn't re-staled.
		if (spawned)
			await this.context.noteContextChange(projectId, scope, {
				exceptBranchId: branchId,
				exceptLocale: locale,
			});
		return saved;
	}
}
