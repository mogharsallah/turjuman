import {
	type Actor,
	canOnProject,
	DEFAULT_NAMESPACE,
	type GlossaryTerm,
	notFound,
	type Project,
	type ProjectRole,
	type ScoreConfig,
	scoreValueSchema,
	type Translation,
	type TranslationKey,
	type TranslationStatus,
	validation,
} from "@turjuman/schema";
import type { ScoreContext } from "@turjuman/schema/scoring";
import {
	buildBatchScorePrompt,
	buildScorePrompt as renderScorePrompt,
	SCORE_PROMPT_VERSION,
} from "@turjuman/schema/scoring";
import { BaseService } from "./base.js";
import type {
	KeyPage,
	ReviewResult,
	ScoreInput,
	ScorePrompt,
	SetScoreConfigInput,
} from "./types.js";

/** Selector for {@link ScoringService.buildScorePrompt}: one key, or a page. */
export type ScorePromptSelection =
	| { name: string; namespace?: string }
	| { limit?: number; cursor?: string };

/**
 * AI quality scoring + review — the persistence + routing seam.
 *
 * Turjuman is BYO-LLM: the grading model runs inside the connected agent, never
 * here. This service owns the three server-side jobs: (1) **serve the prompt** —
 * assemble the MQM rubric + project guidance + glossary + strings (delegating the
 * pure rendering to `@turjuman/schema/scoring`); (2) **record + route** a
 * submitted score, stamping provenance and moving the translation between
 * `translated` / `needs_review` / `approved`; (3) own the per-project
 * {@link ScoreConfig}. It mirrors `QaService` (config seam) and
 * `TranslationsService` (the dual-slot promotion idiom).
 */
export class ScoringService extends BaseService {
	// ---- config ---------------------------------------------------------------

	async getConfig(actor: Actor, projectId: string): Promise<ScoreConfig> {
		await this.authorizeProject(actor, projectId, "project.read");
		return (
			(await this.repo.getScoreConfig(projectId)) ??
			this.defaultConfig(projectId)
		);
	}

	async setConfig(
		actor: Actor,
		projectId: string,
		input: SetScoreConfigInput,
	): Promise<ScoreConfig> {
		await this.authorizeProject(actor, projectId, "project.update");
		if (input.threshold !== undefined)
			this.assertScore(input.threshold, "threshold");
		const existing =
			(await this.repo.getScoreConfig(projectId)) ??
			this.defaultConfig(projectId);
		const merged: ScoreConfig = {
			projectId,
			threshold: input.threshold ?? existing.threshold,
			autoApprove: input.autoApprove ?? existing.autoApprove,
			guidance:
				input.guidance !== undefined ? input.guidance : existing.guidance,
			updatedBy: actor.userId,
			updatedAt: new Date().toISOString(),
		};
		return this.repo.putScoreConfig(merged);
	}

	// ---- scoring + routing ----------------------------------------------------

	/**
	 * Record a score for one translation and route it. Routing (after loading the
	 * project role + config):
	 *  - `score < threshold` → `needs_review`
	 *  - high score AND `autoApprove` AND the actor can `translation.review` AND
	 *    the value is machine-origin (`origin !== "human"`) → `approved` (promote
	 *    `value` → `approvedValue`)
	 *  - otherwise → `translated` (keep `approved` if it was already approved)
	 * The role gate is tested without throwing — a high score by a non-reviewer is
	 * simply left for a human. A re-score overwrites the prior score (no history).
	 */
	async score(
		actor: Actor,
		projectId: string,
		code: string,
		input: ScoreInput,
	): Promise<Translation> {
		const { project, role } = await this.authorizeProject(
			actor,
			projectId,
			"translation.write",
		);
		await this.requireLocaleExists(projectId, code);
		this.assertNotBaseLocale(project, code);
		this.assertScore(input.score, "score");
		const namespace = input.namespace ?? DEFAULT_NAMESPACE;
		const existing = await this.repo.getTranslation(
			projectId,
			code,
			namespace,
			input.name,
		);
		if (!existing)
			throw notFound(`No ${code} translation for ${namespace}/${input.name}`);
		if (!this.hasValue(existing)) {
			throw validation(
				`Cannot score ${namespace}/${input.name} in ${code}: it has no translated value yet`,
			);
		}
		const config =
			(await this.repo.getScoreConfig(projectId)) ??
			this.defaultConfig(projectId);
		return this.repo.putTranslation(
			this.applyScore(existing, input, config, actor, role),
		);
	}

	/** Batch version of {@link score}: many translations in one locale at once. */
	async reviewBatch(
		actor: Actor,
		projectId: string,
		code: string,
		entries: ScoreInput[],
	): Promise<ReviewResult> {
		const { project, role } = await this.authorizeProject(
			actor,
			projectId,
			"translation.write",
		);
		await this.requireLocaleExists(projectId, code);
		this.assertNotBaseLocale(project, code);
		for (const e of entries) this.assertScore(e.score, "score");
		const config =
			(await this.repo.getScoreConfig(projectId)) ??
			this.defaultConfig(projectId);
		const prevByKey = new Map(
			(await this.repo.listTranslationsByLocale(projectId, code)).map((t) => [
				`${t.namespace}#${t.keyName}`,
				t,
			]),
		);
		// Collapse duplicate (namespace, name) entries — last score wins — so each key
		// is routed exactly once off its own pre-batch state and the counters can't
		// double-count one key.
		const byId = new Map<string, ScoreInput>();
		for (const e of entries)
			byId.set(`${e.namespace ?? DEFAULT_NAMESPACE}#${e.name}`, e);

		const toWrite: Translation[] = [];
		const skipped: string[] = [];
		let approved = 0;
		let flagged = 0;
		for (const [id, e] of byId) {
			const existing = prevByKey.get(id);
			// Skip unknown keys and rows with no value yet — a score needs something to grade.
			if (!existing || !this.hasValue(existing)) {
				skipped.push(id);
				continue;
			}
			const next = this.applyScore(existing, e, config, actor, role);
			if (next.status === "approved" && existing.status !== "approved")
				approved++;
			if (next.status === "needs_review") flagged++;
			toWrite.push(next);
		}
		await this.repo.putTranslations(toWrite);
		return { written: toWrite.length, skipped, approved, flagged };
	}

	// ---- review queue ---------------------------------------------------------

	/** Keys whose translation for the locale is flagged `needs_review`, one page at a
	 * time (mirrors `TranslationsService.listStalePage`). */
	async listForReviewPage(
		actor: Actor,
		projectId: string,
		code: string,
		opts: { limit?: number; cursor?: string } = {},
	): Promise<KeyPage> {
		await this.authorizeProject(actor, projectId, "translation.read");
		await this.requireLocaleExists(projectId, code);
		const page = await this.repo.listKeysPage(projectId, {
			limit: opts.limit,
			cursor: opts.cursor,
		});
		const active = page.keys.filter((k) => k.state !== "deprecated");
		const values = await Promise.all(
			active.map((k) =>
				this.repo.getTranslation(projectId, code, k.namespace, k.name),
			),
		);
		const keys = active.filter((_, i) => values[i]?.status === "needs_review");
		return { keys, nextCursor: page.nextCursor };
	}

	// ---- prompt assembly (the methodology seam) -------------------------------

	/**
	 * Assemble a scoring prompt: the MQM rubric + project guidance + glossary +
	 * source/target strings, ready for a reviewer agent to grade. `sel` is one key
	 * (`{ name, namespace }`) or a bounded page (`{ limit?, cursor? }`, the
	 * `review_locale` form). The single seam behind both the MCP prompt and the
	 * REST score-prompt endpoint, so the methodology can't drift. (Context-size
	 * handling for large pages is deferred — bounded to a simple page for now.)
	 */
	async buildScorePrompt(
		actor: Actor,
		projectId: string,
		code: string,
		sel: ScorePromptSelection,
	): Promise<ScorePrompt> {
		const { project } = await this.authorizeProject(
			actor,
			projectId,
			"translation.read",
		);
		await this.requireLocaleExists(projectId, code);
		this.assertNotBaseLocale(project, code);
		const config =
			(await this.repo.getScoreConfig(projectId)) ??
			this.defaultConfig(projectId);
		const glossary = await this.repo.listGlossary(projectId);
		const promptVersion = this.promptVersion(config);

		if ("name" in sel) {
			const namespace = sel.namespace ?? DEFAULT_NAMESPACE;
			const [target, key, base] = await Promise.all([
				this.repo.getTranslation(projectId, code, namespace, sel.name),
				this.repo.getKey(projectId, namespace, sel.name),
				this.repo.getTranslation(
					projectId,
					project.baseLocale,
					namespace,
					sel.name,
				),
			]);
			if (!key) throw notFound(`Key ${namespace}/${sel.name} not found`);
			if (!target)
				throw notFound(`No ${code} translation for ${namespace}/${sel.name}`);
			const ctx = this.toScoreContext(
				project,
				code,
				key,
				base?.value ?? "",
				target.value,
				glossary,
				config,
			);
			return { messages: renderScorePrompt(ctx).messages, promptVersion };
		}

		// Join the page's key metadata and base values with two bulk reads + in-memory
		// maps — the same idiom as `qa.ts buildContexts` — instead of a getKey +
		// base-getTranslation point read per page row. The page is already in SK
		// (namespace#name) order, so no re-sort is needed.
		const page = await this.repo.listTranslationsByLocalePage(projectId, code, {
			limit: sel.limit,
			cursor: sel.cursor,
		});
		const [keys, baseTranslations] = await Promise.all([
			this.repo.listKeys(projectId),
			this.repo.listTranslationsByLocale(projectId, project.baseLocale),
		]);
		const keyById = new Map(keys.map((k) => [`${k.namespace}#${k.name}`, k]));
		const baseById = new Map(
			baseTranslations.map((t) => [`${t.namespace}#${t.keyName}`, t.value]),
		);
		const ctxs: ScoreContext[] = [];
		for (const t of page.translations) {
			const id = `${t.namespace}#${t.keyName}`;
			const key = keyById.get(id);
			// Active keys only — deprecated keys are retained but never reviewed.
			if (!key || key.state === "deprecated") continue;
			ctxs.push(
				this.toScoreContext(
					project,
					code,
					key,
					baseById.get(id) ?? "",
					t.value,
					glossary,
					config,
				),
			);
		}
		return {
			messages: buildBatchScorePrompt(ctxs).messages,
			promptVersion,
			nextCursor: page.nextCursor,
		};
	}

	// ---- internals ------------------------------------------------------------

	private defaultConfig(projectId: string): ScoreConfig {
		return {
			projectId,
			threshold: 90,
			autoApprove: false,
			updatedBy: "",
			updatedAt: "",
		};
	}

	private assertScore(value: number, field: string): void {
		if (!scoreValueSchema.safeParse(value).success) {
			throw validation(`${field} must be an integer between 0 and 100`);
		}
	}

	/** The base locale is the source of truth — there is nothing to grade it against. */
	private assertNotBaseLocale(project: Project, code: string): void {
		if (code === project.baseLocale) {
			throw validation("Cannot score the base locale against itself");
		}
	}

	/** A translation is scoreable only once it carries a non-blank working value. */
	private hasValue(t: Translation): boolean {
		return t.value.trim() !== "";
	}

	/** The effective methodology version stamped onto a score (`+custom` when guided). */
	private promptVersion(config: ScoreConfig): string {
		return config.guidance?.trim()
			? `${SCORE_PROMPT_VERSION}+custom`
			: SCORE_PROMPT_VERSION;
	}

	/** Pure routing: the new translation record for a submitted score. */
	private applyScore(
		existing: Translation,
		input: ScoreInput,
		config: ScoreConfig,
		actor: Actor,
		role: ProjectRole | undefined,
	): Translation {
		const status = this.route(existing, input.score, config, actor, role);
		const now = new Date().toISOString();
		return {
			...existing,
			status,
			// Promote on auto-approval; otherwise keep the last approved snapshot intact.
			approvedValue:
				status === "approved" ? existing.value : existing.approvedValue,
			score: input.score,
			scoreComment: input.comment,
			scoredBy: actor.userId,
			scoredAt: now,
			scoreModel: input.model,
			promptVersion: this.promptVersion(config),
			updatedBy: actor.userId,
			updatedAt: now,
		};
	}

	private route(
		existing: Translation,
		score: number,
		config: ScoreConfig,
		actor: Actor,
		role: ProjectRole | undefined,
	): TranslationStatus {
		if (score < config.threshold) return "needs_review";
		// High score: auto-promote only when opted in, the actor can review, and the
		// value is machine-origin — a human's own edit is never auto-approved by a score.
		if (
			config.autoApprove &&
			existing.origin !== "human" &&
			canOnProject(actor, "translation.review", role)
		) {
			return "approved";
		}
		// High score but not auto-approving: keep an already-approved value approved,
		// otherwise record the score and leave it translated.
		return existing.status === "approved" ? "approved" : "translated";
	}

	private toScoreContext(
		project: Project,
		code: string,
		key: TranslationKey,
		baseValue: string,
		targetValue: string,
		glossary: readonly GlossaryTerm[],
		config: ScoreConfig,
	): ScoreContext {
		return {
			baseLocale: project.baseLocale,
			targetLocale: code,
			key: {
				namespace: key.namespace,
				name: key.name,
				description: key.description,
				maxLength: key.maxLength,
				plural: key.plural,
			},
			baseValue,
			targetValue,
			glossary: glossary.map((g) => ({
				term: g.term,
				translations: g.translations,
				doNotTranslate: g.doNotTranslate,
			})),
			threshold: config.threshold,
			guidance: config.guidance,
		};
	}
}
