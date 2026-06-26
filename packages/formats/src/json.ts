import { isIcuPlural } from "@turjuman/schema";
import { flatten, sortByKey, unflatten } from "./nesting.js";
import type { FormatAdapter, TranslationEntry } from "./types.js";

/** Nested JSON (i18next-style): dotted keys become nested objects. */
export const nestedJsonAdapter: FormatAdapter = {
	id: "json-nested",
	label: "JSON (nested / i18next)",
	extensions: ["json"],
	serialize(entries: TranslationEntry[]): string {
		return JSON.stringify(unflatten(entries), null, 2) + "\n";
	},
	parse(content: string): TranslationEntry[] {
		return flatten(JSON.parse(content));
	},
};

/** Flat JSON: literal dotted keys at the top level, no nesting. */
export const flatJsonAdapter: FormatAdapter = {
	id: "json-flat",
	label: "JSON (flat keys)",
	extensions: ["json"],
	serialize(entries: TranslationEntry[]): string {
		const obj: Record<string, string> = {};
		for (const { key, value } of sortByKey(entries)) obj[key] = value;
		return JSON.stringify(obj, null, 2) + "\n";
	},
	parse(content: string): TranslationEntry[] {
		const obj = JSON.parse(content) as Record<string, unknown>;
		return Object.entries(obj)
			.filter(([, v]) => typeof v !== "object" || v === null)
			.map(([key, v]) => {
				const value = String(v);
				return { key, value, plural: isIcuPlural(value) };
			});
	},
};
