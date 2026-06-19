import { parseIcuSafe } from "../icu.js";
import type { QaCheck } from "../types.js";
import { finding, snippet } from "./util.js";

/** The target value must be parseable ICU MessageFormat. */
export const icuSyntaxCheck: QaCheck = {
  id: "icu_syntax",
  description: "Target value must be valid ICU MessageFormat (balanced braces, well-formed plural/select).",
  severity: "error",
  run(ctx) {
    const value = ctx.targetValue;
    if (value === undefined || value.trim() === "") return []; // empty is the `empty` check's concern
    const res = parseIcuSafe(value);
    if (res.ok) return [];
    return [finding(ctx, this.id, this.severity, `Invalid ICU syntax: ${res.error}`, snippet(value))];
  },
};
