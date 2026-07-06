import { describe, expect, it } from "vitest";
import {
	CASCADE_LADDER,
	type CascadeTarget,
	rankExamples,
	resolveCascade,
	shapeForLocale,
	tierOf,
} from "./cascade.js";
import type {
	ContextRule,
	ContextRuleKind,
	Example,
	GlossaryTerm,
	Scope,
} from "./domain.js";

// One fixed target cell, with distinct per-field sentinels so a coordinate swap
// (key↔namespace, fr↔de) can never pass silently.
const TARGET: CascadeTarget = {
	projectId: "P_proj",
	namespaceId: "NS_ns",
	keyId: "K_key",
	locale: "fr",
};

const T0 = "2026-01-01T00:00:00.000Z";

function rule(
	over: Partial<ContextRule> & { scope: Scope; kind: ContextRuleKind },
): ContextRule {
	return {
		id: "CR_id",
		projectId: "P_proj",
		operator: "override",
		payload: {},
		lifecycle: "active",
		createdBy: "U_author",
		createdAt: T0,
		updatedAt: T0,
		...over,
	};
}

function term(over: Partial<GlossaryTerm> = {}): GlossaryTerm {
	return {
		projectId: "P_proj",
		id: "GT_id",
		term: "cart",
		translations: { fr: "panier" },
		caseSensitive: false,
		doNotTranslate: false,
		lifecycle: "active",
		createdAt: T0,
		updatedAt: T0,
		...over,
	};
}

function example(over: Partial<Example> & { scope: Scope }): Example {
	return {
		id: "EX_id",
		projectId: "P_proj",
		locale: "fr",
		sourceText: "Hello",
		targetText: "Bonjour",
		quality: "accepted",
		lifecycle: "active",
		createdAt: T0,
		updatedAt: T0,
		...over,
	};
}

const resolve = (parts: {
	rules?: ContextRule[];
	glossary?: GlossaryTerm[];
	examples?: Example[];
}) =>
	resolveCascade({
		...TARGET,
		rules: parts.rules ?? [],
		glossary: parts.glossary ?? [],
		examples: parts.examples ?? [],
	});

describe("tierOf — the precedence ladder", () => {
	it("maps each populated scope to its rung", () => {
		expect(
			tierOf({ projectId: "P_proj", keyId: "K_key", locale: "fr" }, TARGET),
		).toBe("key×locale");
		expect(tierOf({ projectId: "P_proj", keyId: "K_key" }, TARGET)).toBe(
			"key×all",
		);
		expect(
			tierOf(
				{ projectId: "P_proj", namespaceId: "NS_ns", locale: "fr" },
				TARGET,
			),
		).toBe("namespace×locale");
		expect(tierOf({ projectId: "P_proj", namespaceId: "NS_ns" }, TARGET)).toBe(
			"namespace×all",
		);
		expect(tierOf({ projectId: "P_proj", locale: "fr" }, TARGET)).toBe(
			"project×locale",
		);
		expect(tierOf({ projectId: "P_proj" }, TARGET)).toBe("project×all");
		expect(tierOf(undefined, TARGET)).toBe("project×all");
	});

	it("excludes a locale-pinned cell for another locale (locale orthogonality)", () => {
		expect(
			tierOf({ projectId: "P_proj", keyId: "K_key", locale: "de" }, TARGET),
		).toBeNull();
	});

	it("excludes a different key or namespace (out of the containment column)", () => {
		expect(
			tierOf({ projectId: "P_proj", keyId: "K_other" }, TARGET),
		).toBeNull();
		expect(
			tierOf({ projectId: "P_proj", namespaceId: "NS_other" }, TARGET),
		).toBeNull();
	});

	it("is ordered narrowest→broadest", () => {
		expect(CASCADE_LADDER).toEqual([
			"key×locale",
			"key×all",
			"namespace×locale",
			"namespace×all",
			"project×locale",
			"project×all",
		]);
	});
});

describe("override — narrowest wins, field by field", () => {
	it("merges voice fields, narrower tier winning; flags cross-tier + raises review", () => {
		const r = resolve({
			rules: [
				rule({
					id: "CR_proj",
					scope: { projectId: "P_proj" },
					kind: "voice",
					payload: { formality: "formal", tone: "neutral" },
				}),
				rule({
					id: "CR_key",
					scope: { projectId: "P_proj", keyId: "K_key" },
					kind: "voice",
					payload: { tone: "playful" },
				}),
			],
		});
		expect(r.voice).toEqual({ formality: "formal", tone: "playful" });
		expect(r.provenance).toEqual([
			{ field: "voice", tier: "key×all", crossTierOverride: true },
		]);
		expect(r.reviewDepth).toBe("raised");
	});

	it("a single tier is not a cross-tier override", () => {
		const r = resolve({
			rules: [
				rule({
					scope: { projectId: "P_proj" },
					kind: "voice",
					payload: { tone: "warm" },
				}),
			],
		});
		expect(r.voice).toEqual({ tone: "warm" });
		expect(r.provenance).toEqual([{ field: "voice", tier: "project×all" }]);
		expect(r.reviewDepth).toBe("normal");
	});

	it("locale overlay: key×locale outranks key×all at the same scope tier", () => {
		const r = resolve({
			rules: [
				rule({
					id: "CR_all",
					scope: { projectId: "P_proj", keyId: "K_key" },
					kind: "voice",
					payload: { tone: "all" },
				}),
				rule({
					id: "CR_loc",
					scope: { projectId: "P_proj", keyId: "K_key", locale: "fr" },
					kind: "voice",
					payload: { tone: "loc" },
				}),
			],
		});
		expect(r.voice).toEqual({ tone: "loc" });
		expect(r.provenance[0]?.tier).toBe("key×locale");
	});

	it("emits a non-voice override as one effective constraint with the merged payload", () => {
		const r = resolve({
			rules: [
				rule({
					scope: { projectId: "P_proj" },
					kind: "length",
					payload: { max: 40 },
				}),
				rule({
					scope: { projectId: "P_proj", keyId: "K_key" },
					kind: "length",
					payload: { max: 20 },
				}),
			],
		});
		expect(r.constraints).toHaveLength(1);
		expect(r.constraints[0]?.kind).toBe("length");
		expect(r.constraints[0]?.payload).toEqual({ max: 20 });
		expect(r.voice).toBeUndefined();
	});

	it("ignores non-active rules", () => {
		const r = resolve({
			rules: [
				rule({
					scope: { projectId: "P_proj" },
					kind: "voice",
					payload: { tone: "active" },
				}),
				rule({
					scope: { projectId: "P_proj", keyId: "K_key" },
					kind: "voice",
					payload: { tone: "proposed" },
					lifecycle: "proposed",
				}),
			],
		});
		expect(r.voice).toEqual({ tone: "active" });
		expect(r.reviewDepth).toBe("normal");
	});
});

describe("union — glossary collects every in-scope tier", () => {
	it("includes project + key + unscoped terms; excludes out-of-scope and inactive", () => {
		const r = resolve({
			glossary: [
				term({ id: "GT_proj", scope: { projectId: "P_proj" }, term: "proj" }),
				term({
					id: "GT_key",
					scope: { projectId: "P_proj", keyId: "K_key" },
					term: "key",
				}),
				term({
					id: "GT_other",
					scope: { projectId: "P_proj", keyId: "K_other" },
					term: "other",
				}),
				term({
					id: "GT_archived",
					scope: { projectId: "P_proj" },
					term: "archived",
					lifecycle: "archived",
				}),
				term({ id: "GT_unscoped", term: "unscoped" }),
			],
		});
		expect(r.glossary.map((g) => g.term).sort()).toEqual([
			"key",
			"proj",
			"unscoped",
		]);
	});
});

describe("restrict — compliance ANDs every tier", () => {
	it("collects all rules and flags a require/forbid contradiction", () => {
		const r = resolve({
			rules: [
				rule({
					id: "CR_p",
					scope: { projectId: "P_proj" },
					kind: "compliance",
					operator: "restrict",
					payload: { mustInclude: ["GDPR"] },
				}),
				rule({
					id: "CR_k",
					scope: { projectId: "P_proj", keyId: "K_key" },
					kind: "compliance",
					operator: "restrict",
					payload: { mustAvoid: ["GDPR"] },
				}),
			],
		});
		expect(r.constraints).toHaveLength(2);
		expect(r.conflicts).toEqual([
			"compliance conflict: GDPR both required and forbidden",
		]);
		expect(r.reviewDepth).toBe("raised");
	});

	it("no contradiction → no conflict, review stays normal", () => {
		const r = resolve({
			rules: [
				rule({
					id: "CR_p",
					scope: { projectId: "P_proj" },
					kind: "compliance",
					operator: "restrict",
					payload: { mustInclude: ["GDPR"] },
				}),
				rule({
					id: "CR_k",
					scope: { projectId: "P_proj", keyId: "K_key" },
					kind: "compliance",
					operator: "restrict",
					payload: { mustAvoid: ["spam"] },
				}),
			],
		});
		expect(r.conflicts).toEqual([]);
		expect(r.reviewDepth).toBe("normal");
		expect(r.constraints).toHaveLength(2);
	});

	it("a `hard` override folds as restrict — both tiers apply, not merged", () => {
		const r = resolve({
			rules: [
				rule({
					id: "CR_p",
					scope: { projectId: "P_proj" },
					kind: "length",
					payload: { max: 40 },
					hard: true,
				}),
				rule({
					id: "CR_k",
					scope: { projectId: "P_proj", keyId: "K_key" },
					kind: "length",
					payload: { max: 20 },
					hard: true,
				}),
			],
		});
		expect(r.constraints).toHaveLength(2);
	});
});

describe("rankExamples — proximity, then quality, then recency", () => {
	it("orders key-scope before project, gold before accepted, newer before older", () => {
		const examples = [
			example({
				id: "EX_proj_gold",
				scope: { projectId: "P_proj" },
				quality: "gold",
			}),
			example({
				id: "EX_key_acc_old",
				scope: { projectId: "P_proj", keyId: "K_key" },
				quality: "accepted",
				updatedAt: "2026-01-01T00:00:00.000Z",
			}),
			example({
				id: "EX_key_acc_new",
				scope: { projectId: "P_proj", keyId: "K_key" },
				quality: "accepted",
				updatedAt: "2026-02-01T00:00:00.000Z",
			}),
			example({
				id: "EX_key_gold",
				scope: { projectId: "P_proj", keyId: "K_key" },
				quality: "gold",
			}),
		];
		expect(rankExamples(examples, TARGET).map((e) => e.id)).toEqual([
			"EX_key_gold",
			"EX_key_acc_new",
			"EX_key_acc_old",
			"EX_proj_gold",
		]);
	});

	it("excludes wrong-locale and inactive examples", () => {
		const examples = [
			example({ id: "EX_de", scope: { projectId: "P_proj" }, locale: "de" }),
			example({
				id: "EX_archived",
				scope: { projectId: "P_proj" },
				lifecycle: "archived",
			}),
			example({ id: "EX_ok", scope: { projectId: "P_proj" } }),
		];
		expect(rankExamples(examples, TARGET).map((e) => e.id)).toEqual(["EX_ok"]);
	});
});

describe("shapeForLocale — deterministic locale post-step", () => {
	it("English: [one, other], left-to-right", () => {
		expect(shapeForLocale("en")).toEqual({
			locale: "en",
			pluralCategories: ["one", "other"],
			rtl: false,
		});
	});

	it("Arabic is RTL with a rich plural-category set", () => {
		const s = shapeForLocale("ar");
		expect(s.rtl).toBe(true);
		expect(s.pluralCategories).toContain("other");
		expect(s.pluralCategories.length).toBeGreaterThan(2);
	});

	it("regional codes resolve to the base language (es-MX, pt-BR)", () => {
		expect(shapeForLocale("es-MX").rtl).toBe(false);
		expect(shapeForLocale("pt-BR").pluralCategories).toContain("other");
	});

	it("degrades safely on a malformed locale", () => {
		const s = shapeForLocale("@@bad");
		expect(s.pluralCategories).toContain("other");
		expect(s.pluralCategories.length).toBeGreaterThan(0);
	});
});
