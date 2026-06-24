import { describe, expect, it } from "vitest";
import { getAdapter } from "./index.js";
import type { TranslationEntry } from "./types.js";

const po = getAdapter("po");

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

describe("PO adapter — idiomatic gettext output", () => {
  it("writes msgid/msgstr, an extracted comment, and a native plural", () => {
    const out = po.serialize([singular, plural], { locale: "en" });
    expect(out).toContain('msgid "app.title"');
    expect(out).toContain('msgstr "Turjuman"');
    expect(out).toContain("#. Header product name");
    // Native gettext plural: msgid_plural + indexed msgstr[N].
    expect(out).toContain('msgid_plural "item.count"');
    expect(out).toContain("msgstr[0]");
    expect(out).toContain("msgstr[1]");
    expect(out).toContain('"Plural-Forms: nplurals=2; plural=(n != 1);');
  });

  it("maps msgstr indices to the locale's CLDR categories (Arabic, 6 forms)", () => {
    const ar: TranslationEntry = {
      key: "files",
      value:
        "{count, plural, zero {no files} one {one file} two {two files} few {a few files} many {many files} other {# files}}",
      plural: true,
    };
    const out = po.serialize([ar], { locale: "ar" });
    expect(out).toContain('"Plural-Forms: nplurals=6;');
    for (let i = 0; i <= 5; i++) expect(out).toContain(`msgstr[${i}]`);

    // Round-trips back through the same locale to the canonical CLDR categories.
    const back = po.parse(out, { locale: "ar" });
    expect(back).toHaveLength(1);
    expect(back[0]!.value).toBe(ar.value);
    expect(back[0]!.plural).toBe(true);
  });

  it("round-trips a singular with its description", () => {
    const back = po.parse(po.serialize([singular], { locale: "en" }), { locale: "en" });
    expect(back).toEqual([singular]);
  });

  it("round-trips a curated 3-form language (Serbian)", () => {
    const sr: TranslationEntry = {
      key: "files",
      value: "{count, plural, one {# fajl} few {# fajla} many {# fajlova}}",
      plural: true,
    };
    const out = po.serialize([sr], { locale: "sr" });
    expect(out).toContain('"Plural-Forms: nplurals=3;');
    expect(po.parse(out, { locale: "sr" })[0]!.value).toBe(sr.value);
  });

  it("round-trips an uncurated multi-form locale via Intl without dropping forms (Welsh)", () => {
    const cy: TranslationEntry = {
      key: "cats",
      value:
        "{count, plural, zero {# cath} one {# gath} two {# gath} few {# cath} many {# chath} other {# cath}}",
      plural: true,
    };
    const out = po.serialize([cy], { locale: "cy" });
    // Six forms emitted — no msgstr dropped despite Welsh not being in the table.
    for (let i = 0; i <= 5; i++) expect(out).toContain(`msgstr[${i}]`);
    expect(po.parse(out, { locale: "cy" })[0]!.value).toBe(cy.value);
  });
});
