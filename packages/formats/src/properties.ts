import { isIcuPlural } from "@turjuman/schema";
import { sortByKey } from "./nesting.js";
import type { FormatAdapter, TranslationEntry } from "./types.js";

/**
 * Java/Spring `.properties`. `key=value` lines, `#` comments mapped to
 * descriptions, classic backslash + `\\uXXXX` escaping. No native plural form —
 * a plural value is written as its raw ICU string (documented limitation).
 */
export const propertiesAdapter: FormatAdapter = {
	id: "properties",
	label: "Java .properties",
	extensions: ["properties"],
	serialize(entries: TranslationEntry[]): string {
		const lines: string[] = [];
		for (const { key, value, description } of sortByKey(entries)) {
			if (description) lines.push(`# ${description.replace(/\r?\n/g, " ")}`);
			lines.push(`${escapeKey(key)}=${escapeValue(value)}`);
		}
		return lines.join("\n") + "\n";
	},
	parse(content: string): TranslationEntry[] {
		const entries: TranslationEntry[] = [];
		const lines = content.split(/\r?\n/);
		let pendingComment: string | undefined;
		for (let i = 0; i < lines.length; i++) {
			let line = lines[i]!;
			const trimmed = line.trimStart();
			if (trimmed === "") continue;
			if (trimmed.startsWith("#") || trimmed.startsWith("!")) {
				pendingComment = trimmed.slice(1).trim();
				continue;
			}
			// Join logical-line continuations (trailing odd number of backslashes).
			while (endsWithContinuation(line) && i + 1 < lines.length) {
				line =
					line.replace(/\\+$/, (m) => m.slice(0, -1)) + lines[++i]!.trimStart();
			}
			const sep = findSeparator(line);
			if (sep === -1) continue;
			const key = unescape(line.slice(0, sep).trim());
			const value = unescape(line.slice(sep + 1).trimStart());
			entries.push({
				key,
				value,
				description: pendingComment,
				plural: isIcuPlural(value),
			});
			pendingComment = undefined;
		}
		return entries;
	},
};

function endsWithContinuation(line: string): boolean {
	const m = /\\+$/.exec(line);
	return !!m && m[0].length % 2 === 1;
}

function findSeparator(line: string): number {
	for (let i = 0; i < line.length; i++) {
		const c = line[i]!;
		if (c === "\\") {
			i++;
			continue;
		}
		if (c === "=" || c === ":") return i;
	}
	return -1;
}

function escapeKey(key: string): string {
	return escapeCommon(key).replace(/[ =:#!]/g, (c) => `\\${c}`);
}

function escapeValue(value: string): string {
	return escapeCommon(value).replace(/^ /, "\\ ");
}

function escapeCommon(s: string): string {
	let out = "";
	for (const ch of s) {
		const code = ch.codePointAt(0)!;
		if (ch === "\\") out += "\\\\";
		else if (ch === "\n") out += "\\n";
		else if (ch === "\t") out += "\\t";
		else if (ch === "\r") out += "\\r";
		else if (code < 0x20 || code > 0x7e)
			out += "\\u" + code.toString(16).padStart(4, "0");
		else out += ch;
	}
	return out;
}

function unescape(s: string): string {
	return s.replace(
		/\\u([0-9a-fA-F]{4})|\\(.)/g,
		(_m, hex: string, ch: string) => {
			if (hex) return String.fromCharCode(parseInt(hex, 16));
			switch (ch) {
				case "n":
					return "\n";
				case "t":
					return "\t";
				case "r":
					return "\r";
				default:
					return ch;
			}
		},
	);
}
