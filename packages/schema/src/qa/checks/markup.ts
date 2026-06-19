import { compareTags, tagTokens } from "../markup.js";
import type { QaCheck } from "../types.js";
import { finding } from "./util.js";

/** HTML/XML tag integrity: the target's tag multiset must match the base's. */
export const markupCheck: QaCheck = {
  id: "markup",
  description: "Target must preserve the same HTML/XML tags (by name) as the base value.",
  severity: "warning",
  run(ctx) {
    const base = ctx.baseValue;
    const target = ctx.targetValue;
    if (!base || target === undefined || target.trim() === "") return [];
    const baseTags = tagTokens(base);
    if (baseTags.size === 0) return []; // base has no markup to preserve
    const diff = compareTags(baseTags, tagTokens(target));
    if (!diff) return [];
    return [finding(ctx, this.id, this.severity, `Markup mismatch: ${diff}.`)];
  },
};
