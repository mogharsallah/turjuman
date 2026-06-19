import { describe, expect, it } from "vitest";
import { getAdapter } from "./index.js";
import type { TranslationEntry } from "./types.js";

const singular: TranslationEntry = {
  key: "app.title",
  value: "Turjuman",
  description: "Header product name",
  plural: false,
};
const plural: TranslationEntry = {
  key: "item.count",
  value: "{count, plural, one {# item} other {# items}}",
  description: "Cart item count",
  plural: true,
};

function roundTrip(id: string, entries: TranslationEntry[]): TranslationEntry[] {
  const a = getAdapter(id);
  return a.parse(a.serialize(entries)).sort((x, y) => x.key.localeCompare(y.key));
}

function pick(entries: TranslationEntry[], fields: (keyof TranslationEntry)[]) {
  return entries.map((e) => Object.fromEntries(fields.map((f) => [f, e[f]])));
}

describe("ARB adapter", () => {
  it("round-trips key, value, description and plural", () => {
    const out = roundTrip("arb", [singular, plural]);
    expect(pick(out, ["key", "value", "description", "plural"])).toEqual(
      pick([singular, plural], ["key", "value", "description", "plural"]),
    );
  });
});

describe(".properties adapter", () => {
  it("round-trips key, value and description (plural value passes through)", () => {
    const out = roundTrip("properties", [singular, plural]);
    expect(pick(out, ["key", "value", "description", "plural"])).toEqual(
      pick([singular, plural], ["key", "value", "description", "plural"]),
    );
  });
});

describe("CSV adapter", () => {
  it("round-trips key, value and description", () => {
    const out = roundTrip("csv", [singular, plural]);
    expect(pick(out, ["key", "value", "description", "plural"])).toEqual(
      pick([singular, plural], ["key", "value", "description", "plural"]),
    );
  });
});

describe("Android adapter", () => {
  it("round-trips key, value and plural (description is write-only)", () => {
    const out = roundTrip("android", [singular, plural]);
    expect(pick(out, ["key", "value", "plural"])).toEqual(
      pick([singular, plural], ["key", "value", "plural"]),
    );
  });

  it("writes <plurals> and <!-- comments -->", () => {
    const xml = getAdapter("android").serialize([singular, plural]);
    expect(xml).toContain("<!-- Header product name -->");
    expect(xml).toContain('<plurals name="item.count">');
    expect(xml).toContain('<item quantity="one">');
  });
});

describe("iOS .strings adapter", () => {
  it("round-trips singulars with descriptions and skips plurals", () => {
    const out = roundTrip("ios-strings", [singular, plural]);
    expect(pick(out, ["key", "value", "description"])).toEqual(
      pick([singular], ["key", "value", "description"]),
    );
  });
});

describe("iOS .stringsdict adapter", () => {
  it("round-trips plurals (var name preserved) and skips singulars", () => {
    const out = roundTrip("ios-stringsdict", [singular, plural]);
    expect(pick(out, ["key", "value", "plural"])).toEqual(
      pick([plural], ["key", "value", "plural"]),
    );
  });
});
