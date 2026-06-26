import { notFound } from "@turjuman/core";
import {
	DEFAULT_LIMIT,
	describeKnowledge,
	KINDS,
	searchKnowledge,
} from "@turjuman/knowledge";
import { runCode } from "@turjuman/sandbox";
import { type Operation, op, z } from "@turjuman/sdk";

/**
 * The code-mode tool surface: a small, fixed set the model uses instead of the
 * full operation toolset.
 *
 *   search(query)  → discover what exists — operations you can call (with typed
 *                    signatures) AND the docs (guides, concepts, reference)
 *   describe(id)   → full detail for one result (op schema, or whole doc page)
 *   run_code(code) → run TypeScript against the SDK in the sandbox; only the
 *                    final result returns
 *
 * `search`/`describe` are thin projections of `@turjuman/knowledge` (one index
 * over the SDK operations + the docs corpus); `run_code` drives
 * `@turjuman/sandbox`. They sit ABOVE the operation layer, so they are defined
 * here (not in `@turjuman/sdk`) and shaped as {@link Operation}s only so the MCP
 * projection can register them through the same path as every other tool. They
 * are advertised exclusively in code mode (mutually exclusive with classic), and
 * the sandbox stays operation-stubs-only: `search`/`describe` are not reachable
 * from inside `run_code`.
 */

/** The knowledge kinds a `search` can be narrowed to — derived from the single
 * `KINDS` source in `@turjuman/knowledge` so the enum can't drift from it. */
const KIND = z.enum(KINDS);

export const codemodeTools: Operation[] = [
	op({
		name: "search",
		description:
			"Search the Turjuman knowledge base — both the SDK operations you can call from run_code (returned " +
			"with typed signatures) AND the documentation (guides, concepts, reference). Pass a `query` with " +
			'specific terms (e.g. "set translation value", "plural handling", "webhook events", "api key scope"); ' +
			"optionally narrow with `kind`. Results come back segmented into `operations` and `docs`, each item " +
			"carrying an `id`; `total`/`hasMore` tell you if the list was trimmed. If the first query is vague, " +
			"search again with more specific terms. Then call describe(id) for full detail, or write run_code. " +
			"Omit `query` to get an orientation: the operation groups plus the core concepts.",
		input: z.object({
			query: z
				.string()
				.optional()
				.describe(
					"Free-text search over operations and docs; omit for a cold-start orientation.",
				),
			kind: KIND.optional().describe(
				"Narrow to one kind: operation | guide | concept | reference | overview.",
			),
			limit: z
				.number()
				.int()
				.positive()
				.max(100)
				.optional()
				.describe(`Max results per segment (default ${DEFAULT_LIMIT}).`),
		}),
		annotations: { readOnlyHint: true },
		handler: (a) =>
			searchKnowledge(a.query ?? "", { kind: a.kind, limit: a.limit }),
	}),
	op({
		name: "describe",
		description:
			'Fetch full detail for one search result by its `id`. For an operation id ("op:<name>") it returns ' +
			"the operation's typed input fields, output shape, signature, and read-only/destructive hints; for a " +
			"docs id it returns the full page text. Use this after search to get everything you need before " +
			"writing run_code.",
		input: z.object({
			id: z
				.string()
				.describe(
					'A result id from search, e.g. "op:set_translation" or "guides/code-mode.mdx#_intro".',
				),
		}),
		annotations: { readOnlyHint: true },
		handler: async (a) => {
			const detail = describeKnowledge(a.id);
			// An unknown id is a model-actionable miss: throw NOT_FOUND so it surfaces
			// as a tool error (isError) with a visible message, rather than a 200-style
			// success whose body happens to contain an `error` key.
			if ("error" in detail) throw notFound(detail.error);
			return detail;
		},
	}),
	op({
		name: "run_code",
		description:
			"Execute TypeScript/JavaScript against the Turjuman SDK in an isolated sandbox and return ONLY " +
			"the final result — saving the tokens and round-trips of calling each tool separately. Call " +
			"operations as `await turjuman.<operation>(args)` (e.g. `const ps = await turjuman.list_projects({})`); " +
			"find operation names and signatures with search/describe. Chain as many calls as you need, then `return` " +
			"a value. Use `console.log(...)` for debug output (returned in `logs`). The sandbox has NO network, " +
			"filesystem, or environment — only SDK calls reach the server, run with your own permissions. " +
			"Returns { ok, result, logs, error, opsUsed, truncated }.",
		input: z.object({
			code: z
				.string()
				.describe(
					"The TypeScript/JavaScript to run. Use `await turjuman.*` and end with `return <value>`.",
				),
		}),
		annotations: { readOnlyHint: false },
		handler: (a, ctx) => runCode({ code: a.code, ctx }),
	}),
];
