import { pluralForms } from "../icu.js";
import type { QaCheck } from "../types.js";
import { finding } from "./util.js";

/** Number of Unicode code points (so surrogate pairs count as one). */
function cpLength(s: string): number {
  return [...s].length;
}

/**
 * Enforce a key's `maxLength`. For plural messages each inner form is measured
 * (the wrapper isn't rendered to the user) and the longest offending form is
 * reported.
 */
export const lengthCheck: QaCheck = {
  id: "length",
  description: "Target value must not exceed the key's maxLength.",
  severity: "warning",
  run(ctx) {
    const max = ctx.key.maxLength;
    const value = ctx.targetValue;
    if (max === undefined || value === undefined || value.trim() === "") return [];

    const parsed = pluralForms(value);
    if (parsed) {
      let worst = 0;
      for (const form of Object.values(parsed.forms)) worst = Math.max(worst, cpLength(form));
      if (worst <= max) return [];
      return [finding(ctx, this.id, this.severity, `Longest plural form is ${worst} characters (max ${max}).`)];
    }

    const len = cpLength(value);
    if (len <= max) return [];
    return [finding(ctx, this.id, this.severity, `Value is ${len} characters (max ${max}).`)];
  },
};
