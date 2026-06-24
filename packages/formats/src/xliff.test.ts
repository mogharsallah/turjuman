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

describe("XLIFF 1.2 adapter", () => {
  const xliff = getAdapter("xliff-1.2");

  it("writes version 1.2 trans-units with target and note", () => {
    const xml = xliff.serialize([singular], { locale: "fr" });
    expect(xml).toContain('<xliff version="1.2"');
    expect(xml).toContain('target-language="fr"');
    expect(xml).toContain('<trans-unit id="app.title">');
    expect(xml).toContain("<target>Turjuman</target>");
    expect(xml).toContain("<note>Header product name</note>");
  });

  it("carries the ICU plural string verbatim in <target>", () => {
    const xml = xliff.serialize([plural]);
    expect(xml).toContain(`<target>${plural.value}</target>`);
    const back = xliff.parse(xml);
    expect(back[0]!.value).toBe(plural.value);
    expect(back[0]!.plural).toBe(true);
  });

  it("preserves numeric-looking values without numeric coercion", () => {
    const nums: TranslationEntry[] = [
      { key: "price", value: "1.20", plural: false },
      { key: "code", value: "007", plural: false },
    ];
    const back = xliff.parse(xliff.serialize(nums));
    expect(back.map((e) => e.value).sort()).toEqual(["007", "1.20"]);
  });

  it("keeps an empty translation empty (no fallback to the key)", () => {
    const back = xliff.parse(xliff.serialize([{ key: "blank", value: "", plural: false }]));
    expect(back[0]!.value).toBe("");
  });
});

describe("XLIFF 2.0 adapter", () => {
  const xliff = getAdapter("xliff-2.0");

  it("writes version 2.0 units with segment/source/target and notes", () => {
    const xml = xliff.serialize([singular], { locale: "de" });
    expect(xml).toContain('version="2.0"');
    expect(xml).toContain('trgLang="de"');
    expect(xml).toContain('<unit id="app.title">');
    expect(xml).toContain("<segment>");
    expect(xml).toContain("<target>Turjuman</target>");
    expect(xml).toContain("<note>Header product name</note>");
  });

  it("escapes XML metacharacters in values", () => {
    const tricky: TranslationEntry = { key: "k", value: "a < b & c > d", plural: false };
    const xml = getAdapter("xliff-2.0").serialize([tricky]);
    expect(xml).toContain("a &lt; b &amp; c &gt; d");
    expect(getAdapter("xliff-2.0").parse(xml)[0]!.value).toBe("a < b & c > d");
  });
});
