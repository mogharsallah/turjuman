import type { QaCheck } from "../types.js";
import { finding, snippet } from "./util.js";

/**
 * Flag when two or more different keys share an identical non-empty value within
 * the same locale — often a copy-paste slip. Info severity, since short strings
 * ("OK", "Yes") are legitimately duplicated.
 */
export const duplicateCheck: QaCheck = {
	id: "duplicate",
	description:
		"Flag identical non-empty values shared by multiple keys in a locale.",
	severity: "info",
	run(ctx) {
		const value = ctx.targetValue;
		if (value === undefined || value.trim() === "") return [];
		const sharing = ctx.localeIndex.get(value);
		if (!sharing || sharing.length < 2) return [];
		const self = `${ctx.key.namespace}#${ctx.key.name}`;
		const others = sharing.filter((id) => id !== self);
		if (others.length === 0) return []; // only this key
		return [
			finding(
				ctx,
				this.id,
				this.severity,
				`Identical value shared with ${others.length} other key(s): ${others.slice(0, 3).join(", ")}${others.length > 3 ? "…" : ""}.`,
				snippet(value),
			),
		];
	},
};
