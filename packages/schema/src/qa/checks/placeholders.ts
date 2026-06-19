import { collectArgNames } from "../icu.js";
import type { QaCheck } from "../types.js";
import { finding } from "./util.js";

/**
 * The set of placeholder/variable names in the target must match the base —
 * a missing variable breaks interpolation, an extra one references nothing.
 * Compared as sets (order and repetition are irrelevant).
 */
export const placeholdersCheck: QaCheck = {
  id: "placeholders",
  description: "Target must reference the same variables/placeholders as the base value.",
  severity: "error",
  run(ctx) {
    const base = ctx.baseValue;
    const target = ctx.targetValue;
    if (!base || base.trim() === "") return []; // nothing to compare against
    if (target === undefined || target.trim() === "") return []; // empty is the `empty` check's concern

    const baseArgs = collectArgNames(base);
    if (baseArgs === null) {
      return [
        finding(ctx, this.id, "info", "Base value is not parseable ICU; placeholder check skipped."),
      ];
    }
    const targetArgs = collectArgNames(target);
    if (targetArgs === null) return []; // icu_syntax reports the target's parse failure

    const missing = [...baseArgs].filter((a) => !targetArgs.has(a));
    const extra = [...targetArgs].filter((a) => !baseArgs.has(a));
    if (missing.length === 0 && extra.length === 0) return [];

    const parts: string[] = [];
    if (missing.length) parts.push(`missing {${missing.join("}, {")}}`);
    if (extra.length) parts.push(`unexpected {${extra.join("}, {")}}`);
    return [finding(ctx, this.id, this.severity, `Placeholder mismatch: ${parts.join("; ")}`)];
  },
};
