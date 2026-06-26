import { z } from "zod";
import type { ScorePromptMessage } from "../wire.js";

/**
 * AI quality scoring — the *methodology* layer.
 *
 * Turjuman is BYO-LLM and serverless: the server never calls a model. Instead it
 * **provides the grading prompt** so any connected agent scores consistently
 * against the same MQM rubric, then records the number the agent returns. This
 * module is pure (no AWS, no I/O): given a {@link ScoreContext} it renders the
 * prompt, and it defines the strict {@link scoreResultSchema} the model must
 * return. All data loading lives in `core/services/scoring.ts` (the single seam),
 * mirroring how the pure `qa/` engine relates to `core/services/qa.ts`.
 */

export type { ScorePromptMessage };

/**
 * The output contract a reviewer model MUST return for a single translation: an
 * integer score and a short rationale. Kept strict so a client can parse it
 * verbatim. The v2 per-category MQM breakdown (`errors[]`) slots in here.
 */
export const scoreResultSchema = z.object({
	score: z.number().int().min(0).max(100),
	comment: z.string(),
});
export type ScoreResult = z.infer<typeof scoreResultSchema>;

/** One glossary entry as the prompt needs it (the renderer ignores per-locale casing). */
export interface ScoreGlossaryTerm {
	term: string;
	translations: Record<string, string>;
	doNotTranslate: boolean;
}

/**
 * Everything the renderer needs to grade ONE string. Built by the service from
 * the data model; the renderer here is pure over it.
 */
export interface ScoreContext {
	baseLocale: string;
	targetLocale: string;
	key: {
		namespace: string;
		name: string;
		description?: string;
		maxLength?: number;
		plural: boolean;
	};
	/** Source-locale value — the reference the target is graded against. */
	baseValue: string;
	/** The target value under review. */
	targetValue: string;
	/** Project glossary, surfaced so the model can penalise term violations. */
	glossary: readonly ScoreGlossaryTerm[];
	/** The project's auto-approve threshold, so the model knows the bar. */
	threshold: number;
	/** Optional per-project evaluation guidance, merged into the prompt. */
	guidance?: string;
}

/** A rendered prompt: the messages only. The service stamps `promptVersion`. */
export interface RenderedPrompt {
	messages: ScorePromptMessage[];
}
