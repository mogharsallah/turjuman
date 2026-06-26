import { describe, expect, it } from "vitest";
import type { GlossaryTerm, QaSeverity } from "../domain.js";
import { CHECKS, getCheck, runChecks } from "./index.js";
import type { QaContext } from "./types.js";

/**
 * Layer 1 — the QA engine as pure decision tables (TESTING.md).
 *
 * Two independent oracles:
 *  1. A structure loop over the `CHECKS` registry — every check returns a
 *     well-formed `QaFinding[]`, is idempotent, and never throws on adversarial
 *     input (these are invariants, not derived from any one check's logic).
 *  2. A hand-authored decision table — per (check, input) the EXPECTED severities
 *     are written out by hand, so a check that silently changes verdict fails a
 *     named row. We assert the severity vector (count + severity, in order),
 *     which is the finding's behavioural contract; messages stay the check's own.
 */

const SENTINEL_NS = "NS_sentinel";
const SENTINEL_KEY = "KEY_sentinel";
const SENTINEL_LOCALE = "fr";

/** A neutral, fully-populated context; each row overrides only what it exercises. */
function ctx(over: Partial<QaContext> = {}): QaContext {
	return {
		baseLocale: "en",
		localeCode: SENTINEL_LOCALE,
		key: {
			namespace: SENTINEL_NS,
			name: SENTINEL_KEY,
			plural: false,
			maxLength: undefined,
			tags: [],
			description: undefined,
		},
		baseValue: "Hello",
		targetValue: "Bonjour",
		targetStatus: "translated",
		expectsValue: true,
		stale: false,
		origin: "llm",
		glossary: [],
		localeIndex: new Map(),
		...over,
	};
}

const dnt: GlossaryTerm = {
	projectId: "p",
	id: "1",
	term: "Turjuman",
	translations: {},
	caseSensitive: false,
	doNotTranslate: true,
	createdAt: "",
	updatedAt: "",
};
const preferred: GlossaryTerm = {
	...dnt,
	id: "2",
	doNotTranslate: false,
	term: "cart",
	translations: { [SENTINEL_LOCALE]: "panier" },
};

function plural(over: Partial<QaContext["key"]> = {}): Partial<QaContext> {
	return { key: { ...ctx().key, plural: true, ...over } };
}

interface Row {
	check: string;
	name: string;
	over: Partial<QaContext>;
	/** Hand-authored expected severities, in produced order. `[]` = no findings. */
	expect: QaSeverity[];
}

// ── The decision table — every expectation hand-written from the spec ──
const TABLE: Row[] = [
	// icu_syntax (error): the target must parse as ICU.
	{
		check: "icu_syntax",
		name: "valid ICU",
		over: { targetValue: "Hello {name}" },
		expect: [],
	},
	{
		check: "icu_syntax",
		name: "blank defers to empty",
		over: { targetValue: "  " },
		expect: [],
	},
	{
		check: "icu_syntax",
		name: "unbalanced brace",
		over: { targetValue: "Hello {name" },
		expect: ["error"],
	},
	{
		check: "icu_syntax",
		name: "html is not ICU's concern",
		over: { targetValue: "<b>x</b>" },
		expect: [],
	},

	// placeholders (error): target variable set must equal base's.
	{
		check: "placeholders",
		name: "matching vars",
		over: { baseValue: "Hi {name}", targetValue: "Salut {name}" },
		expect: [],
	},
	{
		check: "placeholders",
		name: "missing var",
		over: { baseValue: "Hi {name}", targetValue: "Salut" },
		expect: ["error"],
	},
	{
		check: "placeholders",
		name: "extra var",
		over: { baseValue: "Hi", targetValue: "Salut {x}" },
		expect: ["error"],
	},
	{
		check: "placeholders",
		name: "unparseable base ⇒ info skip",
		over: { baseValue: "Hi {name", targetValue: "Salut {name}" },
		expect: ["info"],
	},
	{
		check: "placeholders",
		name: "plural # is not a variable",
		over: {
			...plural(),
			baseValue: "{count, plural, one {# item} other {# items}}",
			targetValue: "{count, plural, one {# article} other {# articles}}",
		},
		expect: [],
	},

	// plural_forms (error; warning on mis-flag).
	{
		check: "plural_forms",
		name: "plural key missing other",
		over: { ...plural(), targetValue: "{n, plural, one {x}}" },
		expect: ["error"],
	},
	{
		check: "plural_forms",
		name: "plural key well-formed",
		over: { ...plural(), targetValue: "{n, plural, one {x} other {y}}" },
		expect: [],
	},
	{
		check: "plural_forms",
		name: "plural key, non-plural value",
		over: { ...plural(), targetValue: "flat" },
		expect: ["error"],
	},
	{
		check: "plural_forms",
		name: "non-plural key with plural value",
		over: { targetValue: "{n, plural, one {x} other {y}}" },
		expect: ["warning"],
	},
	{
		check: "plural_forms",
		name: "non-plural plain value",
		over: { targetValue: "flat" },
		expect: [],
	},

	// markup (warning): tag multiset must match base.
	{
		check: "markup",
		name: "matching tags",
		over: { baseValue: "<b>Hi</b>", targetValue: "<b>Salut</b>" },
		expect: [],
	},
	{
		check: "markup",
		name: "dropped closing tag",
		over: { baseValue: "<b>Hi</b>", targetValue: "<b>Salut" },
		expect: ["warning"],
	},
	{
		check: "markup",
		name: "attribute diff ignored",
		over: {
			baseValue: '<a href="x">Hi</a>',
			targetValue: '<a href="y">Salut</a>',
		},
		expect: [],
	},
	{
		check: "markup",
		name: "base has no markup",
		over: { baseValue: "Hi", targetValue: "Salut" },
		expect: [],
	},

	// length (warning): code-point count vs maxLength.
	{
		check: "length",
		name: "under max",
		over: { key: { ...ctx().key, maxLength: 5 }, targetValue: "abc" },
		expect: [],
	},
	{
		check: "length",
		name: "over max",
		over: { key: { ...ctx().key, maxLength: 3 }, targetValue: "abcd" },
		expect: ["warning"],
	},
	{
		check: "length",
		name: "code points not UTF-16 units",
		over: { key: { ...ctx().key, maxLength: 3 }, targetValue: "😀😀😀" },
		expect: [],
	},
	{
		check: "length",
		name: "no maxLength",
		over: { targetValue: "anything long here" },
		expect: [],
	},

	// whitespace (warning).
	{
		check: "whitespace",
		name: "consecutive spaces",
		over: { targetValue: "a  b" },
		expect: ["warning"],
	},
	{
		check: "whitespace",
		name: "trailing mismatch vs base",
		over: { baseValue: "Hi", targetValue: "Salut " },
		expect: ["warning"],
	},
	{
		check: "whitespace",
		name: "clean",
		over: { baseValue: "Hi", targetValue: "Salut" },
		expect: [],
	},

	// punctuation (info): terminal-mark parity with base.
	{
		check: "punctuation",
		name: "dropped terminal",
		over: { baseValue: "Hello.", targetValue: "Bonjour" },
		expect: ["info"],
	},
	{
		check: "punctuation",
		name: "locale-specific terminal accepted",
		over: { baseValue: "Hello?", targetValue: "مرحبا؟" },
		expect: [],
	},
	{
		check: "punctuation",
		name: "added terminal",
		over: { baseValue: "Hello", targetValue: "Bonjour." },
		expect: ["info"],
	},
	{
		check: "punctuation",
		name: "both plain",
		over: { baseValue: "Hello", targetValue: "Bonjour" },
		expect: [],
	},

	// empty (error): a done status must carry a value.
	{
		check: "empty",
		name: "done but blank",
		over: { expectsValue: true, targetValue: "   " },
		expect: ["error"],
	},
	{
		check: "empty",
		name: "untranslated blank is fine",
		over: {
			expectsValue: false,
			targetValue: "",
			targetStatus: "untranslated",
		},
		expect: [],
	},
	{
		check: "empty",
		name: "done with value",
		over: { expectsValue: true, targetValue: "Bonjour" },
		expect: [],
	},

	// glossary (error for DNT; warning for preferred).
	{
		check: "glossary",
		name: "DNT term dropped",
		over: {
			baseValue: "Use Turjuman",
			targetValue: "Utilisez Calame",
			glossary: [dnt],
		},
		expect: ["error"],
	},
	{
		check: "glossary",
		name: "DNT term preserved",
		over: {
			baseValue: "Use Turjuman",
			targetValue: "Utilisez Turjuman",
			glossary: [dnt],
		},
		expect: [],
	},
	{
		check: "glossary",
		name: "word boundary (no 'art' in 'start')",
		over: {
			baseValue: "start",
			targetValue: "démarrer",
			glossary: [{ ...dnt, term: "art" }],
		},
		expect: [],
	},
	{
		check: "glossary",
		name: "preferred translation unused",
		over: {
			baseValue: "Your cart",
			targetValue: "Votre chariot",
			glossary: [preferred],
		},
		expect: ["warning"],
	},
	{
		check: "glossary",
		name: "preferred translation used",
		over: {
			baseValue: "Your cart",
			targetValue: "Votre panier",
			glossary: [preferred],
		},
		expect: [],
	},

	// duplicate (info): >1 key shares the value within a locale.
	{
		check: "duplicate",
		name: "shared value",
		over: {
			targetValue: "Bonjour",
			localeIndex: new Map([
				["Bonjour", [`${SENTINEL_NS}#${SENTINEL_KEY}`, `${SENTINEL_NS}#other`]],
			]),
		},
		expect: ["info"],
	},
	{
		check: "duplicate",
		name: "unique value (only this key)",
		over: {
			targetValue: "Bonjour",
			localeIndex: new Map([["Bonjour", [`${SENTINEL_NS}#${SENTINEL_KEY}`]]]),
		},
		expect: [],
	},
	{
		check: "duplicate",
		name: "blank value",
		over: { targetValue: "  ", localeIndex: new Map([["  ", ["a", "b"]]]) },
		expect: [],
	},

	// stale (info).
	{ check: "stale", name: "stale", over: { stale: true }, expect: ["info"] },
	{ check: "stale", name: "fresh", over: { stale: false }, expect: [] },

	// coverage (info): no value at all where none is expected.
	{
		check: "coverage",
		name: "missing value, not expected",
		over: { targetValue: undefined, expectsValue: false },
		expect: ["info"],
	},
	{
		check: "coverage",
		name: "has value",
		over: { targetValue: "Bonjour" },
		expect: [],
	},
	{
		check: "coverage",
		name: "expected-but-empty defers to empty",
		over: { targetValue: "", expectsValue: true },
		expect: [],
	},
];

describe("QA decision table", () => {
	describe.each(TABLE)("$check — $name", (row) => {
		const def = getCheck(row.check);
		it("produces exactly the hand-authored severities", () => {
			expect(def, `unknown check "${row.check}"`).toBeDefined();
			const findings = def!.run(ctx(row.over));
			expect(findings.map((f) => f.severity)).toEqual(row.expect);
			// Every finding is tagged with its own check and the context's coordinates.
			for (const f of findings) {
				expect(f.checkId).toBe(row.check);
				expect(f.namespace).toBe(SENTINEL_NS);
				expect(f.keyName).toBe(SENTINEL_KEY);
				expect(f.localeCode).toBe(SENTINEL_LOCALE);
			}
		});
	});

	it("every registered check is exercised by at least one row (completeness ratchet)", () => {
		const covered = new Set(TABLE.map((r) => r.check));
		for (const c of CHECKS) {
			expect(
				covered.has(c.id),
				`no decision-table row for check "${c.id}"`,
			).toBe(true);
		}
	});
});

/**
 * Structure invariants — looped over the registry, independent of any check's
 * logic. These are what make "registry-complete" mean "actually exercised".
 */
const SEVERITIES = new Set<QaSeverity>(["error", "warning", "info"]);

// A spread of hostile contexts no check may throw on.
const ADVERSARIAL: QaContext[] = [
	ctx({ baseValue: undefined, targetValue: undefined, expectsValue: false }),
	ctx({ targetValue: "" }),
	ctx({ baseValue: "{a, plural,", targetValue: "{{{{" }), // malformed ICU both sides
	ctx({ targetValue: "x".repeat(10_000), key: { ...ctx().key, maxLength: 1 } }),
	ctx({ targetValue: "lone surrogate \uD800 here" }),
	ctx({
		baseValue: "Use a.*b",
		targetValue: "x",
		glossary: [{ ...dnt, term: "a.*b" }],
	}), // regex-special term
	ctx({ targetValue: "Bonjour", localeIndex: new Map() }),
];

describe("check registry invariants", () => {
	it("ids are unique", () => {
		const ids = CHECKS.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	describe.each(CHECKS)("$id", (check) => {
		it("never throws on adversarial input and returns well-formed findings", () => {
			for (const c of ADVERSARIAL) {
				const findings = check.run(c);
				expect(Array.isArray(findings)).toBe(true);
				for (const f of findings) {
					expect(f.checkId).toBe(check.id);
					expect(SEVERITIES.has(f.severity)).toBe(true);
					expect(typeof f.message).toBe("string");
					expect(f.namespace).toBe(c.key.namespace);
					expect(f.keyName).toBe(c.key.name);
					expect(f.localeCode).toBe(c.localeCode);
				}
			}
		});

		it("is idempotent (same context ⇒ identical findings)", () => {
			for (const c of ADVERSARIAL) {
				expect(check.run(c)).toEqual(check.run(c));
			}
		});
	});
});

describe("runChecks", () => {
	it("runs all checks by default", () => {
		const c = ctx({ baseValue: "Hi {name}", targetValue: "Salut" }); // placeholder mismatch
		expect(runChecks([c]).some((f) => f.checkId === "placeholders")).toBe(true);
	});

	it("filters to the requested checkIds", () => {
		const c = ctx({ baseValue: "Hi {name}", targetValue: "Salut" });
		const only = runChecks([c], { checkIds: ["icu_syntax"] });
		expect(only.every((f) => f.checkId === "icu_syntax")).toBe(true);
	});

	it("throws on an unknown check id", () => {
		expect(() => runChecks([ctx()], { checkIds: ["nope"] })).toThrow(
			/Unknown QA check/,
		);
	});
});
