import type { GlossaryTerm } from "../../domain.js";
import type { QaCheck } from "../types.js";
import { finding } from "./util.js";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Substring test with word boundaries for alphanumeric terms (so "art" doesn't
 * match inside "start"); falls back to a plain includes for terms with
 * punctuation/symbols where `\b` is meaningless.
 */
function contains(haystack: string, needle: string, caseSensitive: boolean): boolean {
  if (needle === "") return true;
  const flags = caseSensitive ? "u" : "iu";
  const alnum = /^[\p{L}\p{N}]+$/u.test(needle);
  const pattern = alnum ? `\\b${escapeRe(needle)}\\b` : escapeRe(needle);
  return new RegExp(pattern, flags).test(haystack);
}

/**
 * Glossary consistency, anchored on the base value:
 *  - `doNotTranslate` terms present in the base must appear verbatim in the
 *    target (error) — brand/product names must not be localized.
 *  - terms with a preferred per-locale translation should use it in the target
 *    when the term appears in the base (warning).
 */
export const glossaryCheck: QaCheck = {
  id: "glossary",
  description: "Enforce do-not-translate terms and preferred per-locale translations.",
  severity: "error",
  run(ctx) {
    const base = ctx.baseValue;
    const target = ctx.targetValue;
    if (!base || base.trim() === "" || target === undefined || target.trim() === "") return [];

    const out = [];
    for (const term of ctx.glossary as readonly GlossaryTerm[]) {
      if (!contains(base, term.term, term.caseSensitive)) continue; // term not used here

      if (term.doNotTranslate) {
        if (!contains(target, term.term, term.caseSensitive)) {
          out.push(
            finding(ctx, this.id, "error", `Do-not-translate term "${term.term}" is missing from the target.`),
          );
        }
        continue;
      }

      const preferred = term.translations[ctx.localeCode];
      if (preferred && preferred.trim() !== "" && !contains(target, preferred, term.caseSensitive)) {
        out.push(
          finding(
            ctx,
            this.id,
            "warning",
            `Glossary term "${term.term}" should use the preferred ${ctx.localeCode} translation "${preferred}".`,
          ),
        );
      }
    }
    return out;
  },
};
