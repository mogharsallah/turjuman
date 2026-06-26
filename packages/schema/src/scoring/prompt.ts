import { MQM_RUBRIC } from "./rubric.js";
import type {
	RenderedPrompt,
	ScoreContext,
	ScoreGlossaryTerm,
} from "./types.js";

/**
 * Pure prompt renderers — one structured prompt shape, reused by the MCP Prompts
 * capability and the REST score-prompt endpoint, so the methodology can never
 * drift between transports. Each prompt has clearly delimited sections (rubric ·
 * project guidance · glossary · key metadata · source · target · threshold) and
 * ends with a strict JSON-only output contract keyed to `scoreResultSchema`.
 */

const FENCE = "<<<";
const FENCE_END = ">>>";

/** Glossary lines for the prompt; `(none)` when the project has no terms. */
function renderGlossary(
	glossary: readonly ScoreGlossaryTerm[],
	targetLocale: string,
): string {
	if (glossary.length === 0) return "(none)";
	return glossary
		.map((g) => {
			if (g.doNotTranslate)
				return `- "${g.term}" — DO NOT TRANSLATE (keep verbatim)`;
			const preferred = g.translations[targetLocale];
			return preferred
				? `- "${g.term}" → "${preferred}"`
				: `- "${g.term}" — (no preferred ${targetLocale} translation set)`;
		})
		.join("\n");
}

/** The key-metadata block shared by the single and batch prompts. */
function renderKeyMeta(key: ScoreContext["key"]): string {
	const lines = [
		`namespace: ${key.namespace}`,
		`name: ${key.name}`,
		`plural: ${key.plural ? "yes" : "no"}`,
	];
	if (key.description) lines.push(`description: ${key.description}`);
	if (key.maxLength !== undefined) lines.push(`max length: ${key.maxLength}`);
	return lines.join("\n");
}

/** The rubric + guidance + glossary preamble shared by both forms. */
function preamble(
	ctx: Pick<
		ScoreContext,
		"baseLocale" | "targetLocale" | "glossary" | "guidance" | "threshold"
	>,
): string {
	return [
		`You are an expert translation quality reviewer. Grade translations from ${ctx.baseLocale} into ${ctx.targetLocale} and return an MQM quality score from 0 to 100.`,
		"",
		"# MQM rubric",
		MQM_RUBRIC,
		"",
		"# Project guidance",
		ctx.guidance?.trim() ? ctx.guidance.trim() : "(none)",
		"",
		"# Glossary",
		renderGlossary(ctx.glossary, ctx.targetLocale),
		"",
		`# Threshold`,
		`The project auto-approves translations scoring ${ctx.threshold} or above; below that they are flagged for human review. Score honestly — do not inflate toward the threshold.`,
	].join("\n");
}

/** Render a single-string scoring prompt: one JSON object out. */
export function buildScorePrompt(ctx: ScoreContext): RenderedPrompt {
	const text = [
		preamble(ctx),
		"",
		"# Key",
		renderKeyMeta(ctx.key),
		"",
		`# Source (${ctx.baseLocale})`,
		FENCE,
		ctx.baseValue,
		FENCE_END,
		"",
		`# Target (${ctx.targetLocale}) — grade THIS`,
		FENCE,
		ctx.targetValue,
		FENCE_END,
		"",
		"# Output",
		"Return ONLY a JSON object, no prose, exactly:",
		'{"score": <integer 0-100>, "comment": "<one or two sentences citing the main MQM issues, or confirming none>"}',
	].join("\n");
	return { messages: [{ role: "user", text }] };
}

/**
 * Render a batch scoring prompt over a page of strings: one JSON array out, each
 * element keyed by `namespace#name` so the client can map scores back to keys.
 * Reuses the per-string section structure of {@link buildScorePrompt}.
 */
export function buildBatchScorePrompt(
	items: readonly ScoreContext[],
): RenderedPrompt {
	if (items.length === 0) {
		return {
			messages: [
				{
					role: "user",
					text: "There are no translations to review on this page. Return an empty JSON array: []",
				},
			],
		};
	}
	const head = items[0]!;
	const strings = items
		.map((ctx, i) =>
			[
				`## [${i + 1}] ${ctx.key.namespace}#${ctx.key.name}`,
				renderKeyMeta(ctx.key),
				`source: ${FENCE} ${ctx.baseValue} ${FENCE_END}`,
				`target: ${FENCE} ${ctx.targetValue} ${FENCE_END}`,
			].join("\n"),
		)
		.join("\n\n");
	const text = [
		preamble(head),
		"",
		`# Strings to grade (${items.length})`,
		strings,
		"",
		"# Output",
		"Return ONLY a JSON array, no prose, with one object per string above, exactly:",
		'[{"key": "<namespace#name>", "score": <integer 0-100>, "comment": "<one or two sentences>"}, ...]',
	].join("\n");
	return { messages: [{ role: "user", text }] };
}
