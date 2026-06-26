/**
 * The knowledge layer's shared shapes. A `KnowledgeDoc` is one searchable unit —
 * either an SDK operation (carrying a typed signature) or a chunk of a docs page
 * (a heading-delimited section). Both live in one index so `search` can return
 * them together, discriminated by `kind`.
 */

/** Every knowledge kind, single-sourced: `operation` comes from the SDK
 * registry; the rest are docs chunks, classified by their `docs/` subtree. The
 * `Kind` type and the code-mode `search` tool's `kind` enum both derive from
 * this one list so they can't drift. */
export const KINDS = ["operation", "guide", "concept", "reference", "overview"] as const;

/** What a knowledge document is. */
export type Kind = (typeof KINDS)[number];

/** The doc kinds (everything that is not an `operation`). */
export const DOC_KINDS: readonly Kind[] = KINDS.filter((k) => k !== "operation");

/** One searchable unit. `text` is the body BM25 ranks over; the other fields are
 * returned for display / navigation. Operation docs carry `signature`/`group`;
 * doc chunks carry `path`/`anchor`/`headingPath`. */
export interface KnowledgeDoc {
  id: string;
  kind: Kind;
  title: string;
  description: string;
  text: string;
  /** Operation domain group (operations) — e.g. "translations". */
  group?: string;
  /** Compact typed signature (operations only). */
  signature?: string;
  /** Docs-relative source path (doc chunks only), e.g. "guides/code-mode.mdx". */
  path?: string;
  /** Heading slug for in-page linking (doc chunks only). */
  anchor?: string;
  /** Breadcrumb of headings from the page title down (doc chunks only). */
  headingPath?: string[];
}

/** One ranked hit. Mirrors {@link KnowledgeDoc} minus the full `text`, plus a
 * short `snippet` and the relevance `score`. */
export interface SearchResult {
  id: string;
  kind: Kind;
  title: string;
  description: string;
  group?: string;
  signature?: string;
  path?: string;
  anchor?: string;
  snippet?: string;
  score: number;
}

/** A domain summary, used by the cold-start orientation. */
export interface GroupSummary {
  group: string;
  count: number;
  /** A few representative operation names to hint at what the group does. */
  sample: string[];
}

/**
 * The `search` result. Segmented by kind (operations vs docs) so a model reads
 * the signature-vs-explanation split at a glance. `total` is the true number of
 * matches even when each segment is capped (so the model knows it was trimmed).
 * When `oriented` is set, this is the cold-start orientation (empty/vague query):
 * `groups` + a couple of concept pages instead of a keyword ranking.
 */
export interface SearchResponse {
  query: string;
  total: number;
  hasMore: boolean;
  operations: SearchResult[];
  docs: SearchResult[];
  /** Present only for the cold-start orientation. */
  oriented?: boolean;
  /** The operation domains (orientation only). */
  groups?: GroupSummary[];
}

/** A single input field of an operation, rendered for `describe`. */
export interface FieldInfo {
  name: string;
  type: string;
  optional: boolean;
  description?: string;
}

/** Full detail for one operation (the `describe` zoom-in). */
export interface OperationDetail {
  kind: "operation";
  name: string;
  group: string;
  signature: string;
  description: string;
  readOnly: boolean;
  destructive: boolean;
  input: FieldInfo[];
  output?: string;
}

/** Full detail for one docs page (the `describe` zoom-in): the chosen chunk plus
 * its sibling sections, assembled into whole-page context. */
export interface DocDetail {
  kind: Exclude<Kind, "operation">;
  id: string;
  title: string;
  path: string;
  anchor?: string;
  headingPath?: string[];
  text: string;
}

/** `describe(id)` result, or an error when the id is unknown. */
export type DescribeResult = OperationDetail | DocDetail | { error: string };
