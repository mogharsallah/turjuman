import { runCode } from "@turjuman/sandbox";
import { type Operation, op, searchOperations, z } from "@turjuman/sdk";

/**
 * The code-mode tool surface: a tiny, fixed pair the model uses instead of the
 * full operation toolset.
 *
 *   search_sdk(query) → discover which operations exist (signatures + docs)
 *   run_code(code)     → run TypeScript against the SDK in the sandbox; only the
 *                        final result returns
 *
 * These are defined here (not in `@turjuman/sdk`) because they sit ABOVE the
 * operation layer — `run_code` drives `@turjuman/sandbox`, and `search_sdk`
 * introspects the registry. They are shaped as {@link Operation}s only so the MCP
 * projection can register them through the same path as every other tool. They
 * are advertised exclusively in code mode (mutually exclusive with classic).
 */
export const codemodeTools: Operation[] = [
  op({
    name: "search_sdk",
    description:
      "Discover Turjuman SDK operations you can call from run_code. Returns matching operation " +
      "signatures: name, group, one-line description, input field names, and read-only/destructive " +
      "hints. Pass a `query` (e.g. \"translation\", \"create project\", \"glossary\") to filter; omit it " +
      "to list everything. Use this first to find the operations you need, then call run_code.",
    input: z.object({
      query: z
        .string()
        .optional()
        .describe("Free-text search over operation name/group/description; omit to list all."),
      limit: z.number().int().positive().max(100).optional().describe("Max results (default 25)."),
    }),
    annotations: { readOnlyHint: true },
    handler: async (a) => {
      const operations = searchOperations(a.query ?? "", a.limit ?? 25);
      return { count: operations.length, operations };
    },
  }),
  op({
    name: "run_code",
    description:
      "Execute TypeScript/JavaScript against the Turjuman SDK in an isolated sandbox and return ONLY " +
      "the final result — saving the tokens and round-trips of calling each tool separately. Call " +
      "operations as `await turjuman.<operation>(args)` (e.g. `const ps = await turjuman.list_projects({})`); " +
      "find operation names with search_sdk. Chain as many calls as you need, then `return` a value. " +
      "Use `console.log(...)` for debug output (returned in `logs`). The sandbox has NO network, " +
      "filesystem, or environment — only SDK calls reach the server, run with your own permissions. " +
      "Returns { ok, result, logs, error, opsUsed, truncated }.",
    input: z.object({
      code: z
        .string()
        .describe("The TypeScript/JavaScript to run. Use `await turjuman.*` and end with `return <value>`."),
    }),
    annotations: { readOnlyHint: false },
    handler: (a, ctx) => runCode({ code: a.code, ctx }),
  }),
];
