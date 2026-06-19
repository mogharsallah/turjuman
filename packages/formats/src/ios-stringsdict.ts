import plist from "plist";
import type { FormatAdapter, TranslationEntry } from "./types.js";
import { type PluralCategory, PLURAL_CATEGORIES, buildIcuPlural, parseIcuPlural } from "@turjuman/schema";
import { sortByKey } from "./nesting.js";

/**
 * iOS/macOS `Localizable.stringsdict`: a plist of plural rules. Plural entries
 * only (singulars live in the companion `.strings`). The ICU plural variable
 * name is preserved as the format-spec sub-dictionary key so it round-trips.
 */
export const iosStringsdictAdapter: FormatAdapter = {
  id: "ios-stringsdict",
  label: "iOS .stringsdict",
  extensions: ["stringsdict"],
  serialize(entries: TranslationEntry[]): string {
    const root: Record<string, unknown> = {};
    for (const entry of sortByKey(entries)) {
      const plural = parseIcuPlural(entry.value);
      if (!plural) continue; // only plural entries belong here
      const sub: Record<string, string> = {
        NSStringFormatSpecTypeKey: "NSStringPluralRuleType",
        NSStringFormatValueTypeKey: "d",
      };
      for (const cat of PLURAL_CATEGORIES) {
        if (plural.forms[cat] !== undefined) sub[cat] = plural.forms[cat]!;
      }
      root[entry.key] = {
        NSStringLocalizedFormatKey: `%#@${plural.varName}@`,
        [plural.varName]: sub,
      };
    }
    return plist.build(root as unknown as Parameters<typeof plist.build>[0]) + "\n";
  },
  parse(content: string): TranslationEntry[] {
    const root = plist.parse(content) as Record<string, unknown>;
    const entries: TranslationEntry[] = [];
    for (const [key, raw] of Object.entries(root)) {
      if (typeof raw !== "object" || raw === null) continue;
      const dict = raw as Record<string, unknown>;
      // The sub-dictionary is the entry whose value carries a format spec type.
      for (const [subName, subRaw] of Object.entries(dict)) {
        if (subName === "NSStringLocalizedFormatKey") continue;
        if (typeof subRaw !== "object" || subRaw === null) continue;
        const sub = subRaw as Record<string, unknown>;
        if (sub.NSStringFormatSpecTypeKey !== "NSStringPluralRuleType") continue;
        const forms: Partial<Record<PluralCategory, string>> = {};
        for (const cat of PLURAL_CATEGORIES) {
          if (typeof sub[cat] === "string") forms[cat] = sub[cat] as string;
        }
        entries.push({ key, value: buildIcuPlural({ varName: subName, forms }), plural: true });
        break;
      }
    }
    return entries;
  },
};
