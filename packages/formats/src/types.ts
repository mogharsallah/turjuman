/**
 * One translation as seen by a file adapter: a dotted key and its value.
 *
 * `value` is always the canonical **ICU MessageFormat** string (a plain string
 * for simple values, an ICU plural message when `plural` is true). Adapters for
 * formats with native plural/comment support convert to/from this canonical
 * form; simpler adapters (JSON/YAML) ignore the optional fields.
 */
export interface TranslationEntry {
  key: string;
  value: string;
  /** Comment/context, for formats that can carry it (ARB, CSV, .properties, XML). */
  description?: string;
  /** True when `value` is an ICU plural message. */
  plural?: boolean;
}

/**
 * A localization file format. Adapters convert between the canonical list of
 * {@link TranslationEntry} (one locale, one namespace) and on-disk file content.
 * Used by the CLI (build/pull/push) and the REST export/import endpoints.
 */
export interface FormatAdapter {
  /** Stable id used in config, e.g. "json-nested". */
  id: string;
  /** Human label for help/listing. */
  label: string;
  /** File extensions this format typically uses (no leading dot). */
  extensions: string[];
  serialize(entries: TranslationEntry[]): string;
  parse(content: string): TranslationEntry[];
}
