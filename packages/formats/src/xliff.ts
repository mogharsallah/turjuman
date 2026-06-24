import { isIcuPlural } from "@turjuman/schema";
import type { FormatAdapter, FormatContext, TranslationEntry } from "./types.js";
import { sortByKey } from "./nesting.js";
import { asArray, escapeXml, escapeXmlAttr, textOf, xmlParser } from "./xml.js";

/**
 * XLIFF (XML Localization Interchange File Format) — the exchange format between
 * TMS tools and the professional translation supply chain (LSPs). Two versions
 * with different schemas ship as separate adapters: {@link xliff12Adapter} and
 * {@link xliff20Adapter}.
 *
 * XLIFF has no native plural construct, so the canonical ICU plural string rides
 * along **verbatim** in `<target>` (the `plural` flag is re-derived on read).
 * These adapters are monolingual and key-based like every Turjuman adapter: the
 * `id` is the translation key and `<target>` holds the value. The source-language
 * text isn't available to a single-locale adapter, so `<source>` mirrors the key
 * as a reference and the value is read back from `<target>` (falling back to
 * `<source>` only when no `<target>` is present at all). `description` maps to a
 * `<note>`.
 */

/** Value of a unit: the `<target>` text if the element exists (even when empty),
 * else the `<source>` text. Presence — not truthiness — picks the slot, so an
 * intentionally-empty translation stays empty instead of falling back to the key. */
function valueOf(rec: Record<string, unknown>): string {
  return "target" in rec ? textOf(rec.target) : textOf(rec.source);
}

function toEntry(key: string, value: string, description: string): TranslationEntry {
  return { key, value, description: description || undefined, plural: isIcuPlural(value) };
}

export const xliff12Adapter: FormatAdapter = {
  id: "xliff-1.2",
  label: "XLIFF 1.2",
  extensions: ["xlf", "xliff"],
  serialize(entries: TranslationEntry[], ctx?: FormatContext): string {
    const lang = ctx?.locale ?? "und";
    const lines = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">',
      `  <file original="messages" datatype="plaintext" source-language="${escapeXmlAttr(lang)}" target-language="${escapeXmlAttr(lang)}">`,
      "    <body>",
    ];
    for (const e of sortByKey(entries)) {
      lines.push(`      <trans-unit id="${escapeXmlAttr(e.key)}">`);
      lines.push(`        <source>${escapeXml(e.key)}</source>`);
      lines.push(`        <target>${escapeXml(e.value)}</target>`);
      if (e.description) lines.push(`        <note>${escapeXml(e.description)}</note>`);
      lines.push("      </trans-unit>");
    }
    lines.push("    </body>", "  </file>", "</xliff>", "");
    return lines.join("\n");
  },
  parse(content: string): TranslationEntry[] {
    const doc = xmlParser.parse(content) as Record<string, unknown>;
    const xliff = (doc.xliff ?? {}) as Record<string, unknown>;
    const entries: TranslationEntry[] = [];
    for (const fileNode of asArray(xliff.file)) {
      const body = ((fileNode as Record<string, unknown>).body ?? {}) as Record<string, unknown>;
      for (const unit of asArray(body["trans-unit"])) {
        const u = unit as Record<string, unknown>;
        entries.push(toEntry(String(u["@_id"]), valueOf(u), textOf(u.note)));
      }
    }
    return entries;
  },
};

export const xliff20Adapter: FormatAdapter = {
  id: "xliff-2.0",
  label: "XLIFF 2.0",
  extensions: ["xlf", "xliff"],
  serialize(entries: TranslationEntry[], ctx?: FormatContext): string {
    const lang = ctx?.locale ?? "und";
    const lines = [
      '<?xml version="1.0" encoding="utf-8"?>',
      `<xliff xmlns="urn:oasis:names:tc:xliff:document:2.0" version="2.0" srcLang="${escapeXmlAttr(lang)}" trgLang="${escapeXmlAttr(lang)}">`,
      '  <file id="f1">',
    ];
    for (const e of sortByKey(entries)) {
      lines.push(`    <unit id="${escapeXmlAttr(e.key)}">`);
      if (e.description) {
        lines.push("      <notes>");
        lines.push(`        <note>${escapeXml(e.description)}</note>`);
        lines.push("      </notes>");
      }
      lines.push("      <segment>");
      lines.push(`        <source>${escapeXml(e.key)}</source>`);
      lines.push(`        <target>${escapeXml(e.value)}</target>`);
      lines.push("      </segment>");
      lines.push("    </unit>");
    }
    lines.push("  </file>", "</xliff>", "");
    return lines.join("\n");
  },
  parse(content: string): TranslationEntry[] {
    const doc = xmlParser.parse(content) as Record<string, unknown>;
    const xliff = (doc.xliff ?? {}) as Record<string, unknown>;
    const entries: TranslationEntry[] = [];
    for (const fileNode of asArray(xliff.file)) {
      for (const unit of asArray((fileNode as Record<string, unknown>).unit)) {
        const u = unit as Record<string, unknown>;
        const segments = asArray(u.segment);
        const seg = (segments[0] ?? {}) as Record<string, unknown>;
        const notes = (u.notes ?? {}) as Record<string, unknown>;
        entries.push(toEntry(String(u["@_id"]), valueOf(seg), textOf(asArray(notes.note)[0])));
      }
    }
    return entries;
  },
};
