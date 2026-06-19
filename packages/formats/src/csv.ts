import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import type { FormatAdapter, TranslationEntry } from "./types.js";
import { isIcuPlural } from "@turjuman/schema";
import { sortByKey } from "./nesting.js";

/**
 * CSV with `key,value,description` columns. The description column carries
 * per-entry context cleanly, and ICU plural values pass through as-is.
 */
export const csvAdapter: FormatAdapter = {
  id: "csv",
  label: "CSV (key,value,description)",
  extensions: ["csv"],
  serialize(entries: TranslationEntry[]): string {
    const records = sortByKey(entries).map((e) => ({
      key: e.key,
      value: e.value,
      description: e.description ?? "",
    }));
    return stringify(records, { header: true, columns: ["key", "value", "description"] });
  },
  parse(content: string): TranslationEntry[] {
    const rows = parse(content, { columns: true, skip_empty_lines: true, trim: false }) as Record<
      string,
      string
    >[];
    return rows
      .filter((r) => (r.key ?? "").length > 0)
      .map((r) => ({
        key: r.key!,
        value: r.value ?? "",
        description: r.description ? r.description : undefined,
        plural: isIcuPlural(r.value ?? ""),
      }));
  },
};
