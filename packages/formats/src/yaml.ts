import YAML from "js-yaml";
import { flatten, unflatten } from "./nesting.js";
import type { FormatAdapter, TranslationEntry } from "./types.js";

/** YAML with nested keys (Rails/Vue-i18n style). */
export const yamlAdapter: FormatAdapter = {
	id: "yaml",
	label: "YAML (nested)",
	extensions: ["yml", "yaml"],
	serialize(entries: TranslationEntry[]): string {
		return YAML.dump(unflatten(entries), { sortKeys: true, lineWidth: -1 });
	},
	parse(content: string): TranslationEntry[] {
		return flatten(YAML.load(content) ?? {});
	},
};
