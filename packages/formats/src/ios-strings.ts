import { isIcuPlural } from "@turjuman/schema";
import { sortByKey } from "./nesting.js";
import type { FormatAdapter, TranslationEntry } from "./types.js";

/**
 * iOS/macOS `Localizable.strings`: `"key" = "value";` with optional
 * `/* comment *​/` descriptions. Singular entries only — plurals live in the
 * companion `.stringsdict` (configure both as separate CLI targets).
 */
export const iosStringsAdapter: FormatAdapter = {
	id: "ios-strings",
	label: "iOS .strings",
	extensions: ["strings"],
	serialize(entries: TranslationEntry[]): string {
		const lines: string[] = [];
		for (const entry of sortByKey(entries)) {
			if (entry.plural || isIcuPlural(entry.value)) continue; // belongs in .stringsdict
			if (entry.description)
				lines.push(`/* ${entry.description.replace(/\*\//g, "* /")} */`);
			lines.push(`"${escape(entry.key)}" = "${escape(entry.value)}";`);
		}
		return lines.join("\n") + "\n";
	},
	parse(content: string): TranslationEntry[] {
		const entries: TranslationEntry[] = [];
		const re =
			/(?:\/\*([\s\S]*?)\*\/\s*)?"((?:\\.|[^"\\])*)"\s*=\s*"((?:\\.|[^"\\])*)"\s*;/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(content)) !== null) {
			const description = m[1]?.trim();
			entries.push({
				key: unescape(m[2]!),
				value: unescape(m[3]!),
				description: description || undefined,
				plural: false,
			});
		}
		return entries;
	},
};

function escape(s: string): string {
	return s
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\n/g, "\\n")
		.replace(/\t/g, "\\t");
}

function unescape(s: string): string {
	return s.replace(/\\(.)/g, (_m, ch: string) => {
		switch (ch) {
			case "n":
				return "\n";
			case "t":
				return "\t";
			default:
				return ch;
		}
	});
}
