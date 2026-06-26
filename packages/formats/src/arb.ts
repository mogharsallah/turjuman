import { isIcuPlural } from "@turjuman/schema";
import { sortByKey } from "./nesting.js";
import type { FormatAdapter, TranslationEntry } from "./types.js";

/**
 * Flutter ARB (Application Resource Bundle). JSON where each `key` may be paired
 * with an `@key` metadata object, and values are ICU MessageFormat natively
 * (including plurals) — the closest fit to our internal canonical form.
 */
export const arbAdapter: FormatAdapter = {
	id: "arb",
	label: "Flutter ARB",
	extensions: ["arb"],
	serialize(entries: TranslationEntry[]): string {
		const obj: Record<string, unknown> = {};
		for (const { key, value, description } of sortByKey(entries)) {
			obj[key] = value;
			if (description) obj[`@${key}`] = { description };
		}
		return JSON.stringify(obj, null, 2) + "\n";
	},
	parse(content: string): TranslationEntry[] {
		const obj = JSON.parse(content) as Record<string, unknown>;
		const entries: TranslationEntry[] = [];
		for (const [key, value] of Object.entries(obj)) {
			if (key.startsWith("@")) continue; // metadata or @@locale
			if (typeof value !== "string") continue;
			const meta = obj[`@${key}`] as { description?: string } | undefined;
			entries.push({
				key,
				value,
				description: meta?.description,
				plural: isIcuPlural(value),
			});
		}
		return entries;
	},
};
