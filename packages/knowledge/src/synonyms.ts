/**
 * A small domain synonym map. Lexical (BM25) search misses when the caller's
 * vocabulary differs from the docs' — "language" for `locale`, "string" for a
 * translation `key`. We expand the query with domain equivalents before
 * searching; combined with Orama's English stemming (so "translating" →
 * "translat" matches "translation"), this is our dependency-free substitute for
 * semantic embeddings. The `search` tool description also coaches the caller to
 * re-search with specific terms, leaning on the LLM for the rest.
 *
 * Each entry maps a term to equivalents that should also match. Expansion is
 * one-directional per row but the table is written symmetrically where it helps.
 * Keys are matched on stemmed-ish word boundaries (lowercased).
 */
export const SYNONYMS: Record<string, string[]> = {
  // Translating. NB: do NOT map translate→localize/localization — both stem to
  // "local", colliding with `locale`/`add_locale` and pulling locale ops into
  // every translation query.
  translate: ["translation"],
  translation: ["translate"],
  i18n: ["internationalization", "translation"],
  l10n: ["translation"],
  // Locales / languages
  language: ["locale"],
  languages: ["locale", "locales"],
  locale: ["language"],
  // Keys / strings / messages
  string: ["key", "message", "translationkey"],
  message: ["key", "string"],
  key: ["string", "message", "translationkey"],
  // Glossary / terminology
  terminology: ["glossary", "term"],
  glossary: ["term", "terminology"],
  // Members / users / access
  user: ["member", "membership"],
  member: ["user", "membership"],
  permission: ["role", "rbac", "access"],
  role: ["permission", "rbac"],
  access: ["permission", "role"],
  // QA / quality
  quality: ["qa", "check", "lint"],
  qa: ["quality", "check"],
  lint: ["qa", "check", "quality"],
  validation: ["qa", "check"],
  // Lifecycle / status
  status: ["state", "lifecycle"],
  stale: ["outdated", "changed"],
  review: ["approve", "reviewed"],
  approve: ["review", "approved"],
  // Plurals / ICU
  plural: ["pluralization", "icu", "plurals"],
  plurals: ["plural", "pluralization", "icu"],
  // Import / export / files
  import: ["upload", "load", "pull"],
  export: ["download", "bundle", "push"],
  file: ["format", "json", "yaml", "xliff"],
  format: ["file", "adapter"],
  // Webhooks / events
  event: ["webhook", "notification"],
  webhook: ["event", "notification", "hook"],
  notification: ["webhook", "event"],
  // Projects
  project: ["app", "repository"],
};

/**
 * English stopwords + question words, dropped from the query before searching.
 * Orama does not strip stopwords by default, so a bare article like "a" would
 * otherwise match the word "a" in every description ("Revoke **a** key") and
 * dominate the ranking. BM25 only scores query terms, so filtering them here is
 * enough — no index-side change needed.
 */
const STOPWORDS = new Set([
  "a", "an", "the", "of", "to", "for", "with", "and", "or", "but", "in", "on",
  "at", "by", "is", "are", "be", "do", "does", "did", "how", "what", "when",
  "where", "which", "who", "why", "that", "this", "these", "those", "i", "me",
  "my", "you", "your", "we", "our", "it", "its", "as", "from", "into", "can",
  "could", "should", "would", "will", "want", "need", "please", "help", "new",
  "all", "any", "some", "if", "then", "so", "up", "out", "about", "using", "use",
]);

/** Expand a free-text query with domain synonyms: every recognised, non-stopword
 * word adds its equivalents to the term string, so BM25 ORs them in. Stopwords
 * and single characters are dropped (see {@link STOPWORDS}). Deduped, original
 * words kept first so they still dominate the ranking. */
export function expandQuery(query: string): string {
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
  const out = new Set<string>(words);
  for (const w of words) {
    for (const syn of SYNONYMS[w] ?? []) out.add(syn);
  }
  return [...out].join(" ");
}
