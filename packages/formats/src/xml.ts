import { XMLParser } from "fast-xml-parser";

/**
 * Shared XML helpers for the XML-based adapters (Android, XLIFF).
 *
 * `parseTagValue: false` is deliberate: translation values are text, so a value
 * like `"1.20"` or `"007"` must NOT be coerced to a number (which would yield
 * `"1.2"` / `"7"`). Attributes default to un-coerced already.
 */
export const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  trimValues: false,
  processEntities: true,
  parseTagValue: false,
});

/** Normalize a `fast-xml-parser` child (absent | single | repeated) to an array. */
export function asArray(v: unknown): unknown[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Text content of a parsed element, whether a bare string or a `{ #text }` node. */
export function textOf(node: unknown): string {
  if (node === undefined || node === null) return "";
  if (typeof node === "string") return node;
  if (typeof node === "object") {
    const t = (node as Record<string, unknown>)["#text"];
    return t === undefined ? "" : String(t);
  }
  return String(node);
}

/** Escape the five XML metacharacters for use in element text. */
export function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape for use inside a double-quoted XML attribute. */
export function escapeXmlAttr(s: string): string {
  return escapeXml(s).replace(/"/g, "&quot;");
}
