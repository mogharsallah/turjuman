import {
	buildIcuPlural,
	isIcuPlural,
	type PluralCategory,
	parseIcuPlural,
} from "@turjuman/schema";
import {
	type GetTextTranslation,
	type GetTextTranslations,
	po as gettextPo,
} from "gettext-parser";
import { sortByKey } from "./nesting.js";
import { gettextPluralForms } from "./po-plurals.js";
import type {
	FormatAdapter,
	FormatContext,
	TranslationEntry,
} from "./types.js";

/**
 * GNU gettext PO (`.po`). The translation key is the `msgid`; the value is the
 * `msgstr`, and the per-entry `description` rides along as an extracted comment
 * (`#.`). Plural values use native gettext plurals — `msgid_plural` plus
 * `msgstr[0..n-1]` indexed per the locale's `Plural-Forms` rules — converted
 * to/from the canonical ICU plural form. The plural argument name is normalised
 * to `count` on read (PO carries no variable name), matching the other native
 * plural adapters.
 *
 * These files are key-based (msgid is the key, not the source-language text), so
 * `msgid_plural` is set to the key as a reference. Conversion is locale-aware:
 * pass `{ locale }` so the index⇄category mapping is correct.
 */
export const poAdapter: FormatAdapter = {
	id: "po",
	label: "gettext PO",
	extensions: ["po"],
	serialize(entries: TranslationEntry[], ctx?: FormatContext): string {
		const { categories, header } = gettextPluralForms(ctx?.locale);
		const data: GetTextTranslations = {
			charset: "utf-8",
			headers: {
				"Content-Type": "text/plain; charset=utf-8",
				"Plural-Forms": header,
			},
			translations: { "": { "": { msgid: "", msgstr: [""] } } },
		};
		const context = data.translations[""]!;
		for (const entry of sortByKey(entries)) {
			const plural =
				entry.plural || isIcuPlural(entry.value)
					? parseIcuPlural(entry.value)
					: null;
			const t: GetTextTranslation = { msgid: entry.key, msgstr: [] };
			if (entry.description) t.comments = { extracted: entry.description };
			if (plural) {
				t.msgid_plural = entry.key;
				t.msgstr = categories.map((cat) => plural.forms[cat] ?? "");
			} else {
				t.msgstr = [entry.value];
			}
			context[entry.key] = t;
		}
		return gettextPo.compile(data).toString("utf8");
	},
	parse(content: string, ctx?: FormatContext): TranslationEntry[] {
		const { categories } = gettextPluralForms(ctx?.locale);
		const data = gettextPo.parse(content);
		const entries: TranslationEntry[] = [];
		for (const group of Object.values(data.translations)) {
			for (const [msgid, t] of Object.entries(group)) {
				if (msgid === "") continue; // header pseudo-entry
				const description =
					t.comments?.extracted || t.comments?.translator || undefined;
				if (t.msgid_plural) {
					const forms: Partial<Record<PluralCategory, string>> = {};
					t.msgstr.forEach((msg, i) => {
						const cat = categories[i];
						if (cat && msg) forms[cat] = msg;
					});
					entries.push({
						key: msgid,
						value: buildIcuPlural({ varName: "count", forms }),
						description,
						plural: true,
					});
				} else {
					entries.push({
						key: msgid,
						value: t.msgstr[0] ?? "",
						description,
						plural: false,
					});
				}
			}
		}
		return entries;
	},
};
