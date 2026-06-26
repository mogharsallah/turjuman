import {
	buildIcuPlural,
	isIcuPlural,
	type PluralCategory,
	parseIcuPlural,
} from "@turjuman/schema";
import { XMLParser } from "fast-xml-parser";
import { sortByKey } from "./nesting.js";
import type { FormatAdapter, TranslationEntry } from "./types.js";
import { asArray, textOf } from "./xml.js";

/**
 * Android `res/values/strings.xml`. `<string>` for singulars and `<plurals>`
 * with `<item quantity=...>` for plurals (CLDR category ⇄ ICU). Descriptions are
 * written as `<!-- comment -->` for translator context (write-only — the source
 * of truth for descriptions is the key metadata in storage).
 */
export const androidAdapter: FormatAdapter = {
	id: "android",
	label: "Android strings.xml",
	extensions: ["xml"],
	serialize(entries: TranslationEntry[]): string {
		const lines = ['<?xml version="1.0" encoding="utf-8"?>', "<resources>"];
		for (const entry of sortByKey(entries)) {
			if (entry.description)
				lines.push(`  <!-- ${escapeComment(entry.description)} -->`);
			const plural =
				entry.plural || isIcuPlural(entry.value)
					? parseIcuPlural(entry.value)
					: null;
			if (plural) {
				lines.push(`  <plurals name="${entry.key}">`);
				for (const [cat, msg] of Object.entries(plural.forms)) {
					lines.push(`    <item quantity="${cat}">${escapeText(msg!)}</item>`);
				}
				lines.push("  </plurals>");
			} else {
				lines.push(
					`  <string name="${entry.key}">${escapeText(entry.value)}</string>`,
				);
			}
		}
		lines.push("</resources>", "");
		return lines.join("\n");
	},
	parse(content: string): TranslationEntry[] {
		const parser = new XMLParser({
			ignoreAttributes: false,
			attributeNamePrefix: "@_",
			textNodeName: "#text",
			trimValues: false,
			processEntities: true,
		});
		const doc = parser.parse(content) as {
			resources?: Record<string, unknown>;
		};
		const resources = doc.resources ?? {};
		const entries: TranslationEntry[] = [];

		for (const node of asArray(resources.string)) {
			if (typeof node !== "object") continue;
			const rec = node as Record<string, unknown>;
			entries.push({
				key: String(rec["@_name"]),
				value: unescapeText(textOf(rec)),
				plural: false,
			});
		}
		for (const node of asArray(resources.plurals)) {
			if (typeof node !== "object") continue;
			const rec = node as Record<string, unknown>;
			const forms: Partial<Record<PluralCategory, string>> = {};
			for (const item of asArray(rec.item)) {
				const ir = item as Record<string, unknown>;
				forms[String(ir["@_quantity"]) as PluralCategory] = unescapeText(
					textOf(ir),
				);
			}
			entries.push({
				key: String(rec["@_name"]),
				value: buildIcuPlural({ varName: "count", forms }),
				plural: true,
			});
		}
		return entries;
	},
};

function escapeText(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/'/g, "\\'")
		.replace(/"/g, '\\"');
}

function unescapeText(s: string): string {
	// fast-xml-parser already decodes XML entities; reverse the Android-specific escapes.
	return s.replace(/\\(['"])/g, "$1");
}

function escapeComment(s: string): string {
	return s.replace(/-->/g, "--&gt;").replace(/\r?\n/g, " ");
}
