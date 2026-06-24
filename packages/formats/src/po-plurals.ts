import { type PluralCategory, PLURAL_CATEGORIES } from "@turjuman/schema";

/**
 * gettext plural-forms mapping for PO.
 *
 * gettext encodes plurals by **numeric index** (`msgstr[0]`, `msgstr[1]`, …)
 * whose meaning is defined by the file's `Plural-Forms:` header — a `nplurals`
 * count and a C expression. Turjuman's canonical form instead uses **CLDR
 * category names** (`one`/`few`/`other`). To convert, the PO adapter needs the
 * locale: this returns the standard gettext `Plural-Forms` header plus the
 * ordered list of CLDR categories that correspond to indices `0..nplurals-1`.
 *
 * Languages whose gettext form count differs from their plain CLDR category set
 * (the Slavic family folds CLDR `other` into `many`; Arabic uses all six) are
 * curated in {@link TABLE} so the header and category order can never drift.
 * Every other locale is resolved from the runtime's CLDR data via
 * `Intl.PluralRules`, so the right number of forms is always emitted and no
 * `msgstr` is dropped on round-trip — for locales outside the curated table the
 * `Plural-Forms` **expression** is a best-effort approximation (the form count
 * is correct) and may need manual adjustment for external gettext tooling.
 */
export interface GettextPluralInfo {
  /** CLDR categories in gettext index order (index i ⇒ `categories[i]`). */
  categories: PluralCategory[];
  /** The `Plural-Forms:` header value. */
  header: string;
}

// East/South-Slavic 3-form rule (one/few/many), shared by ru/uk/sr/hr/bs/me.
const SLAVIC3 =
  "nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);";
// Czech/Slovak 3-form rule (index 2 carries CLDR many+other).
const CZECH3 = "nplurals=3; plural=((n==1) ? 0 : (n>=2 && n<=4) ? 1 : 2);";

// Keyed by ISO-639 language subtag (lower-cased). Only languages whose gettext
// plural shape differs from the 2-form default need an entry; everything else
// resolves through Intl.PluralRules (see gettextPluralForms).
const TABLE: Record<string, GettextPluralInfo> = {
  // One form — no plural distinction.
  ja: { categories: ["other"], header: "nplurals=1; plural=0;" },
  zh: { categories: ["other"], header: "nplurals=1; plural=0;" },
  ko: { categories: ["other"], header: "nplurals=1; plural=0;" },
  vi: { categories: ["other"], header: "nplurals=1; plural=0;" },
  th: { categories: ["other"], header: "nplurals=1; plural=0;" },
  // Two forms, `n > 1` variant (0 is "one").
  fr: { categories: ["one", "other"], header: "nplurals=2; plural=(n > 1);" },
  pt: { categories: ["one", "other"], header: "nplurals=2; plural=(n > 1);" },
  // Three forms — Slavic family (CLDR other folded into many).
  ru: { categories: ["one", "few", "many"], header: SLAVIC3 },
  uk: { categories: ["one", "few", "many"], header: SLAVIC3 },
  sr: { categories: ["one", "few", "many"], header: SLAVIC3 },
  hr: { categories: ["one", "few", "many"], header: SLAVIC3 },
  bs: { categories: ["one", "few", "many"], header: SLAVIC3 },
  me: { categories: ["one", "few", "many"], header: SLAVIC3 },
  pl: {
    categories: ["one", "few", "many"],
    header:
      "nplurals=3; plural=(n==1 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);",
  },
  // Three forms — Czech/Slovak.
  cs: { categories: ["one", "few", "other"], header: CZECH3 },
  sk: { categories: ["one", "few", "other"], header: CZECH3 },
  // Three forms — Romanian/Lithuanian.
  ro: {
    categories: ["one", "few", "other"],
    header: "nplurals=3; plural=(n==1 ? 0 : (n==0 || (n%100>0 && n%100<20)) ? 1 : 2);",
  },
  lt: {
    categories: ["one", "few", "other"],
    header:
      "nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n%10>=2 && (n%100<10 || n%100>=20) ? 1 : 2);",
  },
  // Four forms — Slovenian.
  sl: {
    categories: ["one", "two", "few", "other"],
    header: "nplurals=4; plural=(n%100==1 ? 0 : n%100==2 ? 1 : n%100==3 || n%100==4 ? 2 : 3);",
  },
  // Six forms — Arabic (CLDR zero/one/two/few/many/other map 1:1 to indices).
  ar: {
    categories: ["zero", "one", "two", "few", "many", "other"],
    header:
      "nplurals=6; plural=(n==0 ? 0 : n==1 ? 1 : n==2 ? 2 : n%100>=3 && n%100<=10 ? 3 : n%100>=11 ? 4 : 5);",
  },
};

/** CLDR cardinal categories the runtime reports for a locale, in canonical order. */
function intlCategories(locale: string): PluralCategory[] {
  try {
    const used = new Set<string>(new Intl.PluralRules(locale).resolvedOptions().pluralCategories);
    const ordered = PLURAL_CATEGORIES.filter((c) => used.has(c));
    return ordered.length ? ordered : ["other"];
  } catch {
    return ["one", "other"];
  }
}

/** Best-effort gettext header for a form count outside the curated table. */
function genericHeader(n: number): string {
  if (n <= 1) return "nplurals=1; plural=0;";
  if (n === 2) return "nplurals=2; plural=(n != 1);";
  // Correct form count (no msgstr dropped on round-trip); the expression is an
  // approximation that external gettext tooling may need to refine.
  return `nplurals=${n}; plural=(n != 1);`;
}

/** Resolve the gettext plural-forms mapping for a (possibly region-tagged) locale. */
export function gettextPluralForms(locale?: string): GettextPluralInfo {
  const lang = (locale ?? "").toLowerCase().split(/[-_]/)[0] ?? "";
  const curated = TABLE[lang];
  if (curated) return curated;
  const categories = intlCategories(locale ?? lang);
  return { categories, header: genericHeader(categories.length) };
}
