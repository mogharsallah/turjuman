import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  PLURAL_CATEGORIES,
  type IcuPlural,
  type PluralCategory,
  buildIcuPlural,
  isIcuPlural,
  parseIcuPlural,
} from "./plural.js";

/** Pinned so a failure reproduces; fast-check also prints the seed on failure. */
const SEED = 0x7c0_de;

describe("ICU plural", () => {
  it("detects plural messages", () => {
    expect(isIcuPlural("{n, plural, one {x} other {y}}")).toBe(true);
    expect(isIcuPlural("plain string")).toBe(false);
  });

  it("parses categories and var name", () => {
    const p = parseIcuPlural("{count, plural, one {# item} other {# items}}");
    expect(p).toEqual({ varName: "count", forms: { one: "# item", other: "# items" } });
  });

  it("ignores non-category selectors like =0", () => {
    const p = parseIcuPlural("{count, plural, =0 {none} one {# item} other {# items}}");
    expect(p?.forms).toEqual({ one: "# item", other: "# items" });
  });

  it("handles nested braces in messages", () => {
    const p = parseIcuPlural("{count, plural, one {{count} item} other {{count} items}}");
    expect(p?.forms).toEqual({ one: "{count} item", other: "{count} items" });
  });

  it("round-trips parse -> build in CLDR order", () => {
    const value = "{count, plural, one {# item} few {# items} other {# items}}";
    expect(buildIcuPlural(parseIcuPlural(value)!)).toBe(value);
  });

  it("returns null for non-plural input", () => {
    expect(parseIcuPlural("just text")).toBeNull();
  });
});

/**
 * Layer 1 property test (TESTING.md): round-trip in the correct direction over
 * the canonical model — generate an `IcuPlural`, never an arbitrary string.
 * Inner messages are scoped to brace-free text so they are values the converter
 * can legitimately represent (an unbalanced `{` is the ICU parser's concern, not
 * this round-trip's).
 */
const ident = fc
  .array(
    fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_".split("")),
    { minLength: 1, maxLength: 8 },
  )
  .map((cs) => cs.join(""));

const innerMsg = fc
  .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz 0123456789#.,!?".split("")), {
    minLength: 1,
    maxLength: 16,
  })
  .map((cs) => cs.join(""));

// A non-empty category set that always includes `other` (the CLDR fallback).
const icuPlural: fc.Arbitrary<IcuPlural> = fc
  .record({
    varName: ident,
    extras: fc.subarray(PLURAL_CATEGORIES.filter((c) => c !== "other") as PluralCategory[]),
    msgs: fc.array(innerMsg, { minLength: 6, maxLength: 6 }),
  })
  .map(({ varName, extras, msgs }) => {
    const cats: PluralCategory[] = [...extras, "other"];
    const forms: Partial<Record<PluralCategory, string>> = {};
    cats.forEach((cat, i) => {
      forms[cat] = msgs[i]!;
    });
    return { varName, forms };
  });

describe("ICU plural — property round-trip", () => {
  it("parseIcuPlural(buildIcuPlural(p)) preserves varName and every form", () => {
    fc.assert(
      fc.property(icuPlural, (p) => {
        const parsed = parseIcuPlural(buildIcuPlural(p));
        expect(parsed).toEqual(p);
      }),
      { seed: SEED, numRuns: 200 },
    );
  });

  it("buildIcuPlural is the canonical fixpoint (serialize∘parse∘serialize == serialize)", () => {
    fc.assert(
      fc.property(icuPlural, (p) => {
        const s = buildIcuPlural(p);
        expect(buildIcuPlural(parseIcuPlural(s)!)).toBe(s);
      }),
      { seed: SEED, numRuns: 200 },
    );
  });
});
