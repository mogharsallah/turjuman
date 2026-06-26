import type { QaCheck } from "../types.js";
import { finding } from "./util.js";

/**
 * A translation that claims to be done (translated/approved) must carry a
 * non-blank value. Uses the service-derived `expectsValue` flag rather than the
 * raw status enum, so the lifecycle state machine can change without touching
 * this check. Untranslated blanks are expected and skipped.
 */
export const emptyCheck: QaCheck = {
	id: "empty",
	description:
		"Translated/approved values must not be empty or whitespace-only.",
	severity: "error",
	run(ctx) {
		if (!ctx.expectsValue) return [];
		const value = ctx.targetValue;
		if (value !== undefined && value.trim() !== "") return [];
		return [
			finding(
				ctx,
				this.id,
				this.severity,
				`Status is "${ctx.targetStatus}" but the value is empty.`,
			),
		];
	},
};
