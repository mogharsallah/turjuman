import type { QaCheck } from "../types.js";
import { finding } from "./util.js";

/**
 * Flag keys with no value at all for a locale (missing coverage). Disabled by
 * default in the per-project config: incomplete translation is normal mid-loop,
 * so this should not fail CI unless a team opts in. Reviewers/managers can enable
 * it to track completeness.
 */
export const coverageCheck: QaCheck = {
	id: "coverage",
	description:
		"Flag keys that have no value for the locale (untranslated coverage gap).",
	severity: "info",
	run(ctx) {
		const value = ctx.targetValue;
		if (value !== undefined && value.trim() !== "") return [];
		if (ctx.expectsValue) return []; // a non-blank-expected empty is the `empty` check's job
		return [
			finding(ctx, this.id, this.severity, "No translation for this locale."),
		];
	},
};
