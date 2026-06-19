import { pluralForms } from "../icu.js";
import type { QaCheck } from "../types.js";
import { finding } from "./util.js";

/**
 * Plural-aware validation:
 *  - a key flagged `plural` must carry an ICU plural message with the `other`
 *    category (the CLDR-required fallback). We deliberately do not require
 *    locale-specific categories (one/few/many/…) — that needs a CLDR rules
 *    dependency and would make findings locale-dependent.
 *  - a value that *is* a plural message on a non-plural key is likely a
 *    mis-flagged key (warning).
 */
export const pluralFormsCheck: QaCheck = {
  id: "plural_forms",
  description: "Plural keys must be ICU plural messages with an `other` form.",
  severity: "error",
  run(ctx) {
    const value = ctx.targetValue;
    if (value === undefined || value.trim() === "") return [];
    const parsed = pluralForms(value);

    if (ctx.key.plural) {
      if (!parsed) {
        return [
          finding(ctx, this.id, this.severity, "Key is marked plural but the value is not an ICU plural message."),
        ];
      }
      if (parsed.forms.other === undefined) {
        return [finding(ctx, this.id, this.severity, "Plural message is missing the required `other` form.")];
      }
      return [];
    }

    if (parsed) {
      return [
        finding(ctx, this.id, "warning", "Value is an ICU plural message but the key is not marked plural."),
      ];
    }
    return [];
  },
};
