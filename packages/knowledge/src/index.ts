/**
 * @turjuman/knowledge — the transport-agnostic knowledge layer.
 *
 * One searchable index over the SDK operations (typed signatures) and the docs
 * corpus (guides, concepts, reference). The code-mode MCP tools `search` and
 * `describe` are thin projections of this layer; it has no
 * `@modelcontextprotocol/sdk` and no AWS dependency, mirroring `@turjuman/sdk`.
 */
export { searchKnowledge, describeKnowledge, DEFAULT_LIMIT, type SearchOptions } from "./search.js";
export { KINDS, DOC_KINDS } from "./types.js";
export type {
  Kind,
  KnowledgeDoc,
  SearchResult,
  SearchResponse,
  GroupSummary,
  FieldInfo,
  OperationDetail,
  DocDetail,
  DescribeResult,
} from "./types.js";
