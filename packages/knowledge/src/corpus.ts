import { GROUP_BY_OPERATION, OPERATIONS } from "@turjuman/sdk";
import rawDocs from "./generated/corpus.json" with { type: "json" };
import { inputFields, operationSignature } from "./signatures.js";
import type { KnowledgeDoc } from "./types.js";

/**
 * Assemble the searchable corpus: the SDK operations (each as a typed signature)
 * plus the docs chunks generated at build time (`scripts/build-corpus.mjs`).
 * Both become {@link KnowledgeDoc}s in one list so `search` ranks them together.
 */

// The corpus is build-time static (operation signatures + a generated JSON), so
// each list is computed once and memoised — rendering every operation signature
// or re-spreading the whole chunk array on each call is pure waste.
let opCache: KnowledgeDoc[] | null = null;
let allCache: KnowledgeDoc[] | null = null;

/** Each operation as a knowledge doc. The searchable `text` blends name, group,
 * description and field names so BM25 ranks an operation well for queries that
 * mention any of them; the `signature` is what the model actually needs to write
 * `run_code`. */
export function operationDocs(): KnowledgeDoc[] {
  if (opCache) return opCache;
  opCache = OPERATIONS.map((op) => {
    const group = GROUP_BY_OPERATION.get(op.name) ?? "other";
    const fields = inputFields(op)
      .map((f) => f.name)
      .join(" ");
    return {
      id: `op:${op.name}`,
      kind: "operation",
      title: op.name,
      group,
      signature: operationSignature(op),
      description: op.description,
      text: `${op.name} ${group} ${op.description} ${fields}`,
    };
  });
  return opCache;
}

/** The build-time docs chunks (guides / concepts / reference / overview). The
 * imported JSON is treated as immutable and returned as-is (callers never mutate
 * it), so there is no per-call clone. */
export function docDocs(): KnowledgeDoc[] {
  return rawDocs as KnowledgeDoc[];
}

/** The full corpus: operations first, then docs chunks. */
export function allDocs(): KnowledgeDoc[] {
  if (!allCache) allCache = [...operationDocs(), ...docDocs()];
  return allCache;
}
