import type { QaCheck } from "../types.js";
import { finding } from "./util.js";

/**
 * Surface stale translations — ones written against a base value that has since
 * changed — in the QA report. The staleness itself is derived by the service
 * (and also available via `list_stale`); consolidating it here gives reviewers a
 * single quality view. Info severity: the last approved value still ships.
 */
export const staleCheck: QaCheck = {
	id: "stale",
	description:
		"Flag translations whose source (base value) has changed since they were written.",
	severity: "info",
	run(ctx) {
		if (!ctx.stale) return [];
		return [
			finding(
				ctx,
				this.id,
				this.severity,
				"Source value changed since this translation was written.",
			),
		];
	},
};
