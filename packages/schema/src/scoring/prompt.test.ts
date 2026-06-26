import { describe, expect, it } from "vitest";
import { translationStatusSchema } from "../domain.js";
import { buildBatchScorePrompt, buildScorePrompt } from "./prompt.js";
import { SCORE_PROMPT_VERSION } from "./rubric.js";
import { type ScoreContext, scoreResultSchema } from "./types.js";

const ctx = (over: Partial<ScoreContext> = {}): ScoreContext => ({
	baseLocale: "en",
	targetLocale: "fr",
	key: {
		namespace: "default",
		name: "greeting",
		plural: false,
		description: "Home greeting",
		maxLength: 40,
	},
	baseValue: "Hello {name}",
	targetValue: "Bonjour {name}",
	glossary: [
		{ term: "Hello", translations: { fr: "Bonjour" }, doNotTranslate: false },
	],
	threshold: 90,
	...over,
});

describe("scoring prompt", () => {
	it("the lifecycle enum includes needs_review", () => {
		expect(translationStatusSchema.options).toContain("needs_review");
	});

	it("renders a structured single-string prompt with every section + a strict JSON contract", () => {
		const { messages } = buildScorePrompt(
			ctx({ guidance: "Use vous, not tu." }),
		);
		expect(messages).toHaveLength(1);
		const text = messages[0]!.text;
		for (const section of [
			"MQM rubric",
			"Project guidance",
			"Glossary",
			"Threshold",
			"Source (en)",
			"Target (fr) — grade THIS",
			"Output",
		]) {
			expect(text).toContain(section);
		}
		expect(text).toContain("Use vous, not tu.");
		expect(text).toContain("Bonjour {name}");
		expect(text).toContain('{"score": <integer 0-100>');
	});

	it("renders (none) for absent guidance/glossary", () => {
		const text = buildScorePrompt(ctx({ guidance: undefined, glossary: [] }))
			.messages[0]!.text;
		expect(text).toMatch(/# Project guidance\n\(none\)/);
		expect(text).toMatch(/# Glossary\n\(none\)/);
	});

	it("renders a batch prompt keyed by namespace#name with a JSON-array contract", () => {
		const text = buildBatchScorePrompt([
			ctx(),
			ctx({
				key: { namespace: "default", name: "farewell", plural: false },
				baseValue: "Bye",
				targetValue: "Au revoir",
			}),
		]).messages[0]!.text;
		expect(text).toContain("default#greeting");
		expect(text).toContain("default#farewell");
		expect(text).toContain('[{"key": "<namespace#name>"');
	});

	it("the batch prompt degrades gracefully to an empty array on an empty page", () => {
		expect(buildBatchScorePrompt([]).messages[0]!.text).toContain("[]");
	});

	it("the result contract accepts a valid score and rejects an out-of-range one", () => {
		expect(
			scoreResultSchema.safeParse({ score: 88, comment: "ok" }).success,
		).toBe(true);
		expect(
			scoreResultSchema.safeParse({ score: 188, comment: "no" }).success,
		).toBe(false);
	});

	it("SCORE_PROMPT_VERSION is a stable, non-empty identifier", () => {
		expect(SCORE_PROMPT_VERSION).toMatch(/\S/);
	});
});
