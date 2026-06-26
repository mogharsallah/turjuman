import type { QaCheck } from "../types.js";
import { finding } from "./util.js";

const leading = (s: string) => /^\s/.test(s);
const trailing = (s: string) => /\s$/.test(s);

/**
 * Whitespace hygiene relative to the base: leading/trailing-whitespace mismatch
 * and internal double spaces. Always a warning — some locales legitimately need
 * a leading space (e.g. French before `:` `?`), so this never blocks CI.
 */
export const whitespaceCheck: QaCheck = {
	id: "whitespace",
	description:
		"Flag leading/trailing-whitespace differences vs base and double spaces.",
	severity: "warning",
	run(ctx) {
		const base = ctx.baseValue;
		const target = ctx.targetValue;
		if (target === undefined || target.trim() === "") return [];
		const issues: string[] = [];
		if (base !== undefined) {
			if (leading(target) !== leading(base)) {
				issues.push(
					leading(target)
						? "unexpected leading whitespace"
						: "missing leading whitespace",
				);
			}
			if (trailing(target) !== trailing(base)) {
				issues.push(
					trailing(target)
						? "unexpected trailing whitespace"
						: "missing trailing whitespace",
				);
			}
		}
		if (/ {2,}/.test(target)) issues.push("contains consecutive spaces");
		if (issues.length === 0) return [];
		return [
			finding(ctx, this.id, this.severity, `Whitespace: ${issues.join("; ")}.`),
		];
	},
};
