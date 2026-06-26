import { create, insertMultiple, search as oramaSearch } from "@orama/orama";
import { GROUP_BY_OPERATION, OPERATIONS_BY_NAME, OPERATION_GROUPS } from "@turjuman/sdk";
import { allDocs, docDocs } from "./corpus.js";
import { inputFields, operationHints, operationSignature, outputType } from "./signatures.js";
import { expandQuery } from "./synonyms.js";
import type {
  DescribeResult,
  GroupSummary,
  Kind,
  KnowledgeDoc,
  SearchResponse,
  SearchResult,
} from "./types.js";

/**
 * The runtime knowledge index. One Orama BM25 index over the SDK operations + the
 * docs corpus, built once (lazily) and reused. Lexical search + English stemming
 * (Orama) + domain synonym expansion ({@link expandQuery}) is our dependency-free,
 * no-network substitute for embeddings; the `search` tool description leans on the
 * caller to refine. Dense/hybrid retrieval is a documented future upgrade (Orama
 * supports it natively) — deferred because query-time embedding needs a network
 * call or a heavy in-Lambda model.
 */

/** Default results per segment, single-sourced so the `search` tool description
 * and this default can't drift. */
export const DEFAULT_LIMIT = 25;

// Orama's generics are heavy; index against a plain schema and keep the full
// KnowledgeDoc in a side map for hydration, so we never depend on Orama's
// document-storage semantics.
const SCHEMA = {
  title: "string",
  group: "string",
  description: "string",
  text: "string",
  kind: "enum",
} as const;

/** Build-time-static lookups over the corpus, computed once: `byId` for search
 * hydration + `describe`, `byPath` for whole-page reassembly, `concepts` for the
 * orientation. Memoised so `describe`/`orientation` never rescan the corpus. */
interface Corpus {
  byId: Map<string, KnowledgeDoc>;
  byPath: Map<string, KnowledgeDoc[]>;
  concepts: KnowledgeDoc[];
}

let corpusCache: Corpus | null = null;

function corpus(): Corpus {
  if (corpusCache) return corpusCache;
  const byId = new Map<string, KnowledgeDoc>();
  const byPath = new Map<string, KnowledgeDoc[]>();
  for (const d of allDocs()) {
    byId.set(d.id, d);
    if (d.path) {
      const arr = byPath.get(d.path);
      if (arr) arr.push(d);
      else byPath.set(d.path, [d]);
    }
  }
  // Page intros of the concept pages (headingPath length 1 == the intro chunk).
  const concepts = docDocs().filter((d) => d.kind === "concept" && (d.headingPath?.length ?? 1) === 1);
  corpusCache = { byId, byPath, concepts };
  return corpusCache;
}

let dbPromise: Promise<unknown> | null = null;

async function buildDb(): Promise<unknown> {
  const db = create({ schema: SCHEMA, components: { tokenizer: { stemming: true } } });
  await insertMultiple(
    db,
    allDocs().map((d) => ({
      id: d.id,
      // Orama's tokenizer does not split on `_`, so `set_translation` would index
      // as one opaque token and never match the word "translation". De-underscore
      // the indexed text (operation names) into words; the display values stay in
      // the corpus map for hydration, untouched.
      title: d.title.replace(/_/g, " "),
      group: d.group ?? "",
      description: d.description,
      text: d.text.replace(/_/g, " "),
      kind: d.kind,
    })),
  );
  return db;
}

/** Get (building on first use) the shared Orama index. */
function getDb(): Promise<unknown> {
  if (!dbPromise) dbPromise = buildDb();
  return dbPromise;
}

/** Down-weight reference (which often restates an operation signature) and
 * slightly down-weight overview pages, so explanatory prose and the canonical
 * operation signatures win over restated reference. */
function kindWeight(kind: Kind): number {
  switch (kind) {
    case "reference":
      return 0.6;
    case "overview":
      return 0.85;
    default:
      return 1; // operation / guide / concept
  }
}

function snippetOf(doc: KnowledgeDoc): string | undefined {
  if (doc.kind === "operation") return undefined; // signature + description suffice
  const flat = doc.text.replace(/\s+/g, " ").trim();
  return flat.length > 240 ? `${flat.slice(0, 237)}…` : flat;
}

function toResult(doc: KnowledgeDoc, score: number): SearchResult {
  return {
    id: doc.id,
    kind: doc.kind,
    title: doc.title,
    description: doc.description,
    group: doc.group,
    signature: doc.signature,
    path: doc.path,
    anchor: doc.anchor,
    snippet: snippetOf(doc),
    score,
  };
}

export interface SearchOptions {
  /** Narrow to one kind (e.g. only operations, or only guides). */
  kind?: Kind;
  /** Max results per segment (operations / docs). Default {@link DEFAULT_LIMIT}. */
  limit?: number;
}

/**
 * Search the knowledge base. Returns operations and docs segmented by kind, with
 * the true `total` match count (so a capped result is visibly trimmed). An empty
 * query — or one that is all stopwords, so nothing meaningful is left to search —
 * returns the cold-start {@link orientation} instead of a keyword ranking.
 */
export async function searchKnowledge(query: string, opts: SearchOptions = {}): Promise<SearchResponse> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const q = (query ?? "").trim();
  const term = q ? expandQuery(q) : "";
  // `term` is empty when the query is empty OR entirely stopwords/single chars.
  // Orama treats an empty term as match-all, which would dump the whole corpus in
  // arbitrary order; route both cases to the curated orientation instead.
  if (!term) return orientation();

  const db = await getDb();
  const { byId } = corpus();
  const res = await oramaSearch(db as Parameters<typeof oramaSearch>[0], {
    term,
    properties: ["title", "group", "description", "text"],
    boost: { title: 3, group: 2, description: 2, text: 1 },
    // No typo tolerance: agent queries rarely misspell, and fuzzy matching adds
    // spurious hits. Recall comes from stemming + synonym expansion instead.
    limit: 200,
    // `kind` is an enum field: Orama filters it with an operator object.
    ...(opts.kind ? { where: { kind: { eq: opts.kind } } } : {}),
  });

  // Apply the per-kind weighting, then split + cap BEFORE building snippets, so
  // snippet work only runs on the results actually returned (not all 200 hits).
  const ranked = res.hits
    .map((h) => {
      const doc = byId.get(String(h.id));
      return doc ? { doc, score: h.score * kindWeight(doc.kind) } : null;
    })
    .filter((r): r is { doc: KnowledgeDoc; score: number } => r !== null)
    .sort((a, b) => b.score - a.score);

  const cap = (ofKind: (k: Kind) => boolean) =>
    ranked.filter((r) => ofKind(r.doc.kind)).slice(0, limit).map((r) => toResult(r.doc, r.score));
  const operations = cap((k) => k === "operation");
  const docs = cap((k) => k !== "operation");
  const total = res.count;
  return { query: q, total, hasMore: total > operations.length + docs.length, operations, docs };
}

/** The cold-start orientation: the operation domains (so the agent sees the shape
 * of the system) + the concept pages (how it works), instead of an arbitrary
 * registry slice. Returned for an empty or all-stopword query. */
export function orientation(): SearchResponse {
  const groups: GroupSummary[] = Object.entries(OPERATION_GROUPS).map(([group, ops]) => ({
    group,
    count: ops.length,
    sample: ops.slice(0, 5).map((o) => o.name),
  }));
  const concepts = corpus().concepts.map((d) => toResult(d, 0));
  const total = groups.reduce((n, g) => n + g.count, 0);
  return { query: "", total, hasMore: false, oriented: true, groups, operations: [], docs: concepts };
}

/**
 * Full detail for one result (the `describe` zoom-in / progressive-disclosure
 * second tier). `op:<name>` returns the operation's typed fields + output +
 * hints; a doc id returns the whole page (the chosen chunk plus its siblings).
 */
export function describeKnowledge(id: string): DescribeResult {
  if (id.startsWith("op:")) {
    const op = OPERATIONS_BY_NAME.get(id.slice(3));
    if (!op) return { error: `Unknown operation: ${id}. Use search to find a valid id.` };
    const hints = operationHints(op);
    return {
      kind: "operation",
      name: op.name,
      group: GROUP_BY_OPERATION.get(op.name) ?? "other",
      signature: operationSignature(op),
      description: op.description,
      readOnly: hints.readOnly,
      destructive: hints.destructive,
      input: inputFields(op),
      output: outputType(op),
    };
  }

  const { byId, byPath } = corpus();
  const chunk = byId.get(id);
  if (!chunk || !chunk.path || chunk.kind === "operation") {
    return { error: `Unknown document: ${id}. Use search to find a valid id.` };
  }
  // Reassemble the whole page from its sibling chunks (same source path), in
  // corpus order, so the model gets full context rather than one section.
  const text = (byPath.get(chunk.path) ?? [chunk])
    .map((d) => ((d.headingPath?.length ?? 1) > 1 ? `## ${d.title}\n\n${d.text}` : d.text))
    .join("\n\n");
  return {
    kind: chunk.kind as Exclude<Kind, "operation">,
    id: chunk.id,
    title: chunk.headingPath?.[0] ?? chunk.title,
    path: chunk.path,
    anchor: chunk.anchor,
    headingPath: chunk.headingPath,
    text,
  };
}
