/**
 * @turjuman/knowledge — the transport-agnostic knowledge layer.
 *
 * One searchable index over the SDK operations (typed signatures) and the docs
 * corpus (guides, concepts, reference). The code-mode MCP tools `search` and
 * `describe` are thin projections of this layer; it has no
 * `@modelcontextprotocol/sdk` and no AWS dependency, mirroring `@turjuman/sdk`.
 */
export {
	DEFAULT_LIMIT,
	describeKnowledge,
	type SearchOptions,
	searchKnowledge,
} from "./search.js";
export type {
	DescribeResult,
	DocDetail,
	FieldInfo,
	GroupSummary,
	Kind,
	KnowledgeDoc,
	OperationDetail,
	SearchResponse,
	SearchResult,
} from "./types.js";
export { DOC_KINDS, KINDS } from "./types.js";
