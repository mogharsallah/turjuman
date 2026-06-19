import { TYPE, parse } from "@formatjs/icu-messageformat-parser";

/**
 * ICU MessageFormat plural converter.
 *
 * Turjuman stores plural values as a single canonical ICU plural message, e.g.
 *   `{count, plural, one {# item} other {# items}}`
 * Native mobile formats (Android `<plurals>`, iOS `.stringsdict`) instead use a
 * map of CLDR categories. These helpers convert between the two.
 *
 * Parsing uses the standard `@formatjs/icu-messageformat-parser`. Each plural
 * option's inner message is preserved **verbatim** (including nested `{...}`
 * placeholders and `#`) by slicing the source string with the option's captured
 * `location`, rather than re-printing the AST.
 */

export type PluralCategory = "zero" | "one" | "two" | "few" | "many" | "other";

export const PLURAL_CATEGORIES: readonly PluralCategory[] = [
  "zero",
  "one",
  "two",
  "few",
  "many",
  "other",
];

const CATEGORY_SET = new Set<string>(PLURAL_CATEGORIES);

export interface IcuPlural {
  /** The plural argument name, e.g. "count". */
  varName: string;
  /** Message per CLDR category. */
  forms: Partial<Record<PluralCategory, string>>;
}

const HEAD_RE = /^\s*\{\s*([A-Za-z0-9_]+)\s*,\s*plural\s*,\s*([\s\S]*)\}\s*$/;

/** Quick test without fully parsing. */
export function isIcuPlural(value: string): boolean {
  return HEAD_RE.test(value);
}

/**
 * Parse an ICU plural message into `{ varName, forms }`, or `null` if the whole
 * string isn't a single plural message. Non-CLDR selectors (e.g. `=0`) are
 * ignored, since native plural formats only carry category forms.
 */
export function parseIcuPlural(value: string): IcuPlural | null {
  const source = value.trim();
  let ast;
  try {
    ast = parse(source, { captureLocation: true });
  } catch {
    return null; // malformed ICU
  }
  // The value must be exactly one plural element (no surrounding text).
  if (ast.length !== 1) return null;
  const el = ast[0];
  if (!el || el.type !== TYPE.plural) return null;

  const forms: Partial<Record<PluralCategory, string>> = {};
  for (const [selector, option] of Object.entries(el.options)) {
    if (!CATEGORY_SET.has(selector)) continue; // skip "=N" exact selectors
    const loc = option.location;
    if (!loc) continue;
    // `location` spans the option's `{...}`; strip the outer braces to recover
    // the inner message text verbatim (nested braces and `#` preserved).
    forms[selector as PluralCategory] = source.slice(loc.start.offset + 1, loc.end.offset - 1);
  }
  return Object.keys(forms).length > 0 ? { varName: el.value, forms } : null;
}

/** Build a canonical ICU plural message from categories (emitted in CLDR order). */
export function buildIcuPlural(plural: IcuPlural): string {
  const parts: string[] = [];
  for (const cat of PLURAL_CATEGORIES) {
    const msg = plural.forms[cat];
    if (msg !== undefined) parts.push(`${cat} {${msg}}`);
  }
  return `{${plural.varName}, plural, ${parts.join(" ")}}`;
}
