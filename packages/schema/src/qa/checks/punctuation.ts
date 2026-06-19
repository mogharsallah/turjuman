import type { QaCheck } from "../types.js";
import { finding } from "./util.js";

/**
 * Terminal-punctuation consistency with the base. Locale-specific sentence marks
 * (CJK `。？！`, Devanagari `।`, Arabic `؟`) are treated as equivalent to their
 * ASCII counterparts so non-Latin scripts don't false-positive. Info severity —
 * punctuation conventions vary, so this is advisory only.
 */
const TERMINALS = ".!?:。？！；：।؟…";

function terminalClass(s: string): "sentence" | "none" {
  const trimmed = s.trimEnd();
  const last = [...trimmed].pop() ?? "";
  return TERMINALS.includes(last) ? "sentence" : "none";
}

export const punctuationCheck: QaCheck = {
  id: "punctuation",
  description: "Flag when the target's terminal punctuation differs from the base.",
  severity: "info",
  run(ctx) {
    const base = ctx.baseValue;
    const target = ctx.targetValue;
    if (!base || base.trim() === "" || target === undefined || target.trim() === "") return [];
    const b = terminalClass(base);
    const t = terminalClass(target);
    if (b === t) return [];
    const msg =
      b === "sentence"
        ? "Base ends with terminal punctuation but the target does not."
        : "Target ends with terminal punctuation but the base does not.";
    return [finding(ctx, this.id, this.severity, msg)];
  },
};
