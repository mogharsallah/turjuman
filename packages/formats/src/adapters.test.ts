import { buildIcuPlural, parseIcuPlural } from "@turjuman/schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ADAPTERS, getAdapter } from "./index.js";
import type { TranslationEntry } from "./types.js";

/**
 * Layer 1 — format-adapter round-trips in the CORRECT direction (TESTING.md):
 * `parse(serialize(entries)) ≈ entries` over the canonical model. `≈` is a
 * per-adapter **field-survival spec** declared as data below and compared by ONE
 * central comparator (`assertSurvives`) — inline per-format normalization is
 * banned, since that is how `≈` erodes to nothing. The spec is hand-authored
 * from each format's capabilities, independent of the adapter implementation.
 *
 * Pinned seed so property failures reproduce.
 */
const SEED = 0xf0_4a75;

type Entries = "all" | "singular" | "plural";

interface Survival {
	id: string;
	/** Does a round-trip preserve the `description` field? (write-only ⇒ false) */
	keepsDescription: boolean;
	/** Which entries come back: all, only singulars, or only plurals. */
	entries: Entries;
	/**
	 * Does a plural value round-trip its ICU **variable name**? Formats that store
	 * the ICU string verbatim do; formats that store a CLDR category map (Android
	 * `<plurals>`, gettext PO) reconstruct the message with a canonical var name,
	 * so the name is *not* preserved (the category→message mapping still is).
	 */
	keepsPluralVarName: boolean;
}

// ── Field-survival specs — what each format can faithfully represent ──
const SURVIVAL: Survival[] = [
	{
		id: "json-nested",
		keepsDescription: false,
		entries: "all",
		keepsPluralVarName: true,
	},
	{
		id: "json-flat",
		keepsDescription: false,
		entries: "all",
		keepsPluralVarName: true,
	},
	{
		id: "yaml",
		keepsDescription: false,
		entries: "all",
		keepsPluralVarName: true,
	},
	{
		id: "arb",
		keepsDescription: true,
		entries: "all",
		keepsPluralVarName: true,
	},
	{
		id: "properties",
		keepsDescription: true,
		entries: "all",
		keepsPluralVarName: true,
	},
	{
		id: "csv",
		keepsDescription: true,
		entries: "all",
		keepsPluralVarName: true,
	},
	// <!-- comment --> is write-only; <plurals> stores a category map (var name lost).
	{
		id: "android",
		keepsDescription: false,
		entries: "all",
		keepsPluralVarName: false,
	},
	{
		id: "ios-strings",
		keepsDescription: true,
		entries: "singular",
		keepsPluralVarName: true,
	}, // .strings has no plurals
	{
		id: "ios-stringsdict",
		keepsDescription: false,
		entries: "plural",
		keepsPluralVarName: true,
	}, // plurals-only
	// gettext stores plurals by numeric index ⇒ var name reconstructed.
	{
		id: "po",
		keepsDescription: true,
		entries: "all",
		keepsPluralVarName: false,
	},
	{
		id: "xliff-1.2",
		keepsDescription: true,
		entries: "all",
		keepsPluralVarName: true,
	},
	{
		id: "xliff-2.0",
		keepsDescription: true,
		entries: "all",
		keepsPluralVarName: true,
	},
];

const SURVIVAL_BY_ID = new Map(SURVIVAL.map((s) => [s.id, s]));

/** The set of input entries a spec says should survive the round-trip. */
function expectedSurvivors(
	entries: TranslationEntry[],
	spec: Survival,
): TranslationEntry[] {
	if (spec.entries === "singular") return entries.filter((e) => !e.plural);
	if (spec.entries === "plural") return entries.filter((e) => e.plural);
	return entries;
}

/**
 * Canonicalize a plural value's variable name to a fixed token so two values that
 * differ only by the ICU arg name compare equal. Non-plural values pass through.
 */
function stripPluralVarName(value: string): string {
	const p = parseIcuPlural(value);
	return p ? buildIcuPlural({ varName: "_", forms: p.forms }) : value;
}

/**
 * THE central comparator. Asserts `output ≈ input` under `spec`: exactly the
 * surviving keys come back, each with its value and normalized `plural` flag, and
 * `description` iff the format keeps it. Throws (via expect) on any divergence —
 * self-tested below so the comparator itself can't silently weaken.
 */
function assertSurvives(
	input: TranslationEntry[],
	output: TranslationEntry[],
	spec: Survival,
): void {
	const expected = expectedSurvivors(input, spec);
	const got = new Map(output.map((e) => [e.key, e]));

	expect([...got.keys()].sort()).toEqual(expected.map((e) => e.key).sort());

	for (const exp of expected) {
		const actual = got.get(exp.key);
		expect(actual, `key "${exp.key}" did not survive`).toBeDefined();
		const norm = (v: string) =>
			spec.keepsPluralVarName ? v : stripPluralVarName(v);
		expect(norm(actual!.value), `value for "${exp.key}"`).toBe(norm(exp.value));
		expect(Boolean(actual!.plural), `plural flag for "${exp.key}"`).toBe(
			Boolean(exp.plural),
		);
		if (spec.keepsDescription) {
			expect(actual!.description, `description for "${exp.key}"`).toBe(
				exp.description,
			);
		}
	}
}

function roundTrip(
	id: string,
	entries: TranslationEntry[],
): TranslationEntry[] {
	const a = getAdapter(id);
	return a.parse(a.serialize(entries));
}

// ── Hand-authored golden corpus ──
const singular: TranslationEntry = {
	key: "app.title",
	value: "Turjuman",
	description: "Header product name",
	plural: false,
};
const greeting: TranslationEntry = {
	key: "greeting.hello",
	value: "Hello, {name}!",
	description: "Greeting with a name placeholder",
	plural: false,
};
const plural: TranslationEntry = {
	key: "item.count",
	value: "{count, plural, one {# item} other {# items}}",
	description: "Cart item count",
	plural: true,
};
const GOLDEN = [singular, greeting, plural];

describe("adapter registry ↔ survival spec", () => {
	it("every registered adapter has a field-survival spec (completeness ratchet)", () => {
		for (const a of ADAPTERS) {
			expect(
				SURVIVAL_BY_ID.has(a.id),
				`no survival spec for adapter "${a.id}"`,
			).toBe(true);
		}
	});
	it("every spec names a real adapter", () => {
		const ids = new Set(ADAPTERS.map((a) => a.id));
		for (const s of SURVIVAL)
			expect(ids.has(s.id), `spec "${s.id}" is not a real adapter`).toBe(true);
	});
});

describe("golden round-trip — parse(serialize(GOLDEN)) ≈ GOLDEN", () => {
	describe.each(SURVIVAL)("$id", (spec) => {
		it("matches its field-survival spec", () => {
			assertSurvives(GOLDEN, roundTrip(spec.id, GOLDEN), spec);
		});
	});
});

// ── Generators scoped so they never emit inputs a format cannot represent ──
const ident = fc
	.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789".split("")), {
		minLength: 1,
		maxLength: 6,
	})
	.map((cs) => cs.join(""))
	.filter((s) => /^[a-z]/.test(s));

const dottedKey = fc
	.array(ident, { minLength: 1, maxLength: 3 })
	.map((p) => p.join("."));

// Conservative value alphabet that every adapter round-trips (no quotes/brackets/
// newlines/format delimiters): letters, digits, spaces, a little punctuation.
const text = fc
	.array(
		fc.constantFrom(
			..."abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,!?".split(
				"",
			),
		),
		{
			minLength: 1,
			maxLength: 24,
		},
	)
	.map((cs) => cs.join(""))
	.map((s) => s.trim())
	// Avoid leading/trailing/double-space ambiguity; require a letter so a
	// purely-numeric value isn't coerced to a number by the XML/numeric parsers
	// (a known format limitation, not a round-trip the adapter promises).
	.filter((s) => s.length > 0 && !/ {2,}/.test(s) && /[a-zA-Z]/.test(s));

const pluralValue = fc
	.record({ v: ident, one: text, other: text })
	.map(({ v, one, other }) =>
		buildIcuPlural({ varName: v, forms: { one, other } }),
	);

const entriesArb: fc.Arbitrary<TranslationEntry[]> = fc
	.uniqueArray(dottedKey, { minLength: 1, maxLength: 6, selector: (k) => k })
	.chain((keys) =>
		fc.tuple(
			...keys.map((key) =>
				fc
					.record({
						isPlural: fc.boolean(),
						text,
						pluralValue,
						description: fc.option(text, { nil: undefined }),
					})
					.map(({ isPlural, text: t, pluralValue: pv, description }) => {
						const e: TranslationEntry = {
							key,
							value: isPlural ? pv : t,
							plural: isPlural,
						};
						if (description !== undefined) e.description = description;
						return e;
					}),
			),
		),
	);

describe("property round-trip — parse(serialize(entries)) ≈ entries", () => {
	describe.each(SURVIVAL)("$id", (spec) => {
		it("holds for generated canonical entries", () => {
			fc.assert(
				fc.property(entriesArb, (entries) => {
					assertSurvives(entries, roundTrip(spec.id, entries), spec);
				}),
				{ seed: SEED, numRuns: 60 },
			);
		});
	});
});

describe("serialization is a fixpoint — serialize(parse(serialize(x))) == serialize(parse(x))", () => {
	describe.each(SURVIVAL)("$id", (spec) => {
		it("re-serializing the parsed form is stable", () => {
			const a = getAdapter(spec.id);
			const s1 = a.serialize(GOLDEN);
			const s2 = a.serialize(a.parse(s1));
			const s3 = a.serialize(a.parse(s2));
			expect(s3).toBe(s2);
		});
	});
});

/**
 * The comparator must itself fail when a field is dropped or mangled — otherwise
 * `≈` is theatre. These pin its teeth.
 */
describe("assertSurvives (self-test)", () => {
	const full: Survival = {
		id: "x",
		keepsDescription: true,
		entries: "all",
		keepsPluralVarName: true,
	};
	it("passes an exact echo", () => {
		expect(() => assertSurvives(GOLDEN, GOLDEN, full)).not.toThrow();
	});
	it("fails when a value is mangled", () => {
		const broken = GOLDEN.map((e) =>
			e.key === singular.key ? { ...e, value: "WRONG" } : e,
		);
		expect(() => assertSurvives(GOLDEN, broken, full)).toThrow();
	});
	it("fails when a kept description is dropped", () => {
		const broken = GOLDEN.map(({ description: _drop, ...rest }) => rest);
		expect(() => assertSurvives(GOLDEN, broken, full)).toThrow();
	});
	it("fails when an entry goes missing", () => {
		expect(() => assertSurvives(GOLDEN, GOLDEN.slice(1), full)).toThrow();
	});
	it("ignores description when the spec says it is not kept", () => {
		const noDesc: Survival = {
			id: "x",
			keepsDescription: false,
			entries: "all",
			keepsPluralVarName: true,
		};
		const stripped = GOLDEN.map(({ description: _d, ...rest }) => rest);
		expect(() => assertSurvives(GOLDEN, stripped, noDesc)).not.toThrow();
	});
});
