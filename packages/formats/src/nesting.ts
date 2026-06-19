import { isIcuPlural } from "@turjuman/schema";
import type { TranslationEntry } from "./types.js";

/** Build a nested object from dotted keys, e.g. `a.b -> { a: { b } }`. */
export function unflatten(entries: TranslationEntry[]): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const { key, value } of sortByKey(entries)) {
    const parts = key.split(".");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!;
      const next = node[part];
      if (typeof next !== "object" || next === null) node[part] = {};
      node = node[part] as Record<string, unknown>;
    }
    node[parts[parts.length - 1]!] = value;
  }
  return root;
}

/** Collapse a nested object back into dotted-key entries. */
export function flatten(obj: unknown, prefix = ""): TranslationEntry[] {
  const out: TranslationEntry[] = [];
  if (obj === null || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object") {
      out.push(...flatten(v, key));
    } else {
      const value = String(v);
      out.push({ key, value, plural: isIcuPlural(value) });
    }
  }
  return out;
}

export function sortByKey(entries: TranslationEntry[]): TranslationEntry[] {
  return [...entries].sort((a, b) => a.key.localeCompare(b.key));
}
