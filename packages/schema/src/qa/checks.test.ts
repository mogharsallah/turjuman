import { describe, expect, it } from "vitest";
import type { GlossaryTerm } from "../domain.js";
import { CHECKS, getCheck, runChecks } from "./index.js";
import type { QaContext } from "./types.js";

/** Build a QaContext with sensible defaults; override per test. */
function ctx(over: Partial<QaContext> = {}): QaContext {
  return {
    baseLocale: "en",
    localeCode: "fr",
    key: { namespace: "default", name: "k", plural: false, maxLength: undefined, tags: [], description: undefined },
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

/** Run one check by id over one context. */
function check(id: string, c: QaContext) {
  const def = getCheck(id);
  if (!def) throw new Error(`no check ${id}`);
  return def.run(c);
}

describe("icu_syntax", () => {
  it("passes valid ICU and plain strings", () => {
    expect(check("icu_syntax", ctx({ targetValue: "Hello {name}" }))).toEqual([]);
  });
  it("flags unbalanced braces", () => {
    expect(check("icu_syntax", ctx({ targetValue: "Hello {name" }))).toHaveLength(1);
  });
  it("ignores HTML tags (markup's concern, not ICU)", () => {
    expect(check("icu_syntax", ctx({ targetValue: "<b>Bonjour</b>" }))).toEqual([]);
  });
});

describe("placeholders", () => {
  it("passes when variable sets match", () => {
    expect(
      check("placeholders", ctx({ baseValue: "Hi {name}", targetValue: "Salut {name}" })),
    ).toEqual([]);
  });
  it("flags a missing variable", () => {
    const f = check("placeholders", ctx({ baseValue: "Hi {name}", targetValue: "Salut" }));
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("error");
  });
  it("does not count the plural # as a variable", () => {
    expect(
      check(
        "placeholders",
        ctx({
          key: { ...ctx().key, plural: true },
          baseValue: "{count, plural, one {# item} other {# items}}",
          targetValue: "{count, plural, one {# article} other {# articles}}",
        }),
      ),
    ).toEqual([]);
  });
  it("skips (info) when the base is unparseable", () => {
    const f = check("placeholders", ctx({ baseValue: "Hi {name", targetValue: "Salut {name}" }));
    expect(f[0]!.severity).toBe("info");
  });
});

describe("plural_forms", () => {
  it("requires the other form on plural keys", () => {
    const f = check(
      "plural_forms",
      ctx({ key: { ...ctx().key, plural: true }, targetValue: "{n, plural, one {x}}" }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("error");
  });
  it("passes a well-formed plural", () => {
    expect(
      check(
        "plural_forms",
        ctx({ key: { ...ctx().key, plural: true }, targetValue: "{n, plural, one {x} other {y}}" }),
      ),
    ).toEqual([]);
  });
  it("warns on a plural value for a non-plural key", () => {
    const f = check("plural_forms", ctx({ targetValue: "{n, plural, one {x} other {y}}" }));
    expect(f[0]!.severity).toBe("warning");
  });
});

describe("markup", () => {
  it("passes matching tags", () => {
    expect(
      check("markup", ctx({ baseValue: "<b>Hi</b>", targetValue: "<b>Salut</b>" })),
    ).toEqual([]);
  });
  it("flags a dropped closing tag", () => {
    const f = check("markup", ctx({ baseValue: "<b>Hi</b>", targetValue: "<b>Salut" }));
    expect(f).toHaveLength(1);
  });
  it("ignores attribute differences", () => {
    expect(
      check("markup", ctx({ baseValue: '<a href="x">Hi</a>', targetValue: '<a href="y">Salut</a>' })),
    ).toEqual([]);
  });
});

describe("length", () => {
  it("counts code points, not UTF-16 units", () => {
    // "😀😀😀" is 3 code points but 6 UTF-16 units.
    expect(
      check("length", ctx({ key: { ...ctx().key, maxLength: 3 }, targetValue: "😀😀😀" })),
    ).toEqual([]);
  });
  it("flags overflow", () => {
    expect(
      check("length", ctx({ key: { ...ctx().key, maxLength: 3 }, targetValue: "abcd" })),
    ).toHaveLength(1);
  });
});

describe("whitespace", () => {
  it("flags consecutive spaces", () => {
    expect(check("whitespace", ctx({ targetValue: "a  b" }))).toHaveLength(1);
  });
  it("flags trailing-whitespace mismatch vs base", () => {
    expect(check("whitespace", ctx({ baseValue: "Hi", targetValue: "Salut " }))).toHaveLength(1);
  });
});

describe("punctuation", () => {
  it("flags a dropped terminal mark", () => {
    expect(check("punctuation", ctx({ baseValue: "Hello.", targetValue: "Bonjour" }))).toHaveLength(1);
  });
  it("accepts locale-specific terminals", () => {
    expect(check("punctuation", ctx({ baseValue: "Hello?", targetValue: "مرحبا؟" }))).toEqual([]);
  });
});

describe("empty", () => {
  it("flags a translated-but-blank value", () => {
    const f = check("empty", ctx({ targetValue: "   ", expectsValue: true }));
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("error");
  });
  it("skips untranslated blanks", () => {
    expect(
      check("empty", ctx({ targetValue: "", expectsValue: false, targetStatus: "untranslated" })),
    ).toEqual([]);
  });
});

describe("glossary", () => {
  const dnt: GlossaryTerm = {
    projectId: "p", id: "1", term: "Turjuman", translations: {}, caseSensitive: false,
    doNotTranslate: true, createdAt: "", updatedAt: "",
  };
  it("flags a do-not-translate term missing from the target", () => {
    const f = check(
      "glossary",
      ctx({ baseValue: "Use Turjuman", targetValue: "Utilisez Calame", glossary: [dnt] }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("error");
  });
  it("passes when the DNT term is preserved", () => {
    expect(
      check("glossary", ctx({ baseValue: "Use Turjuman", targetValue: "Utilisez Turjuman", glossary: [dnt] })),
    ).toEqual([]);
  });
  it("uses word boundaries (no 'art' inside 'start')", () => {
    const art: GlossaryTerm = { ...dnt, term: "art" };
    // base "start" contains "art" only as a substring -> term is not 'used' -> no finding
    expect(check("glossary", ctx({ baseValue: "start", targetValue: "démarrer", glossary: [art] }))).toEqual([]);
  });
  it("warns when a preferred translation is unused", () => {
    const pref: GlossaryTerm = { ...dnt, doNotTranslate: false, term: "cart", translations: { fr: "panier" } };
    const f = check("glossary", ctx({ baseValue: "Your cart", targetValue: "Votre chariot", glossary: [pref] }));
    expect(f[0]!.severity).toBe("warning");
  });
});

describe("duplicate", () => {
  it("flags only when >1 key shares the value", () => {
    const index = new Map([["Bonjour", ["default#k", "default#k2"]]]);
    expect(check("duplicate", ctx({ targetValue: "Bonjour", localeIndex: index }))).toHaveLength(1);
  });
  it("does not flag a unique value", () => {
    const index = new Map([["Bonjour", ["default#k"]]]);
    expect(check("duplicate", ctx({ targetValue: "Bonjour", localeIndex: index }))).toEqual([]);
  });
});

describe("stale", () => {
  it("flags stale contexts", () => {
    expect(check("stale", ctx({ stale: true }))).toHaveLength(1);
  });
  it("is silent when fresh", () => {
    expect(check("stale", ctx({ stale: false }))).toEqual([]);
  });
});

describe("coverage", () => {
  it("flags keys with no value when not expected", () => {
    expect(
      check("coverage", ctx({ targetValue: undefined, expectsValue: false })),
    ).toHaveLength(1);
  });
});

describe("runChecks", () => {
  it("runs all checks by default and filters with checkIds", () => {
    const c = ctx({ baseValue: "Hi {name}", targetValue: "Salut" }); // placeholder mismatch
    const all = runChecks([c]);
    expect(all.some((f) => f.checkId === "placeholders")).toBe(true);
    const only = runChecks([c], { checkIds: ["icu_syntax"] });
    expect(only.every((f) => f.checkId === "icu_syntax")).toBe(true);
  });
  it("throws on an unknown check id", () => {
    expect(() => runChecks([ctx()], { checkIds: ["nope"] })).toThrow(/Unknown QA check/);
  });
  it("registry ids are unique", () => {
    const ids = CHECKS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
