/**
 * @turjuman/sdk — the transport-agnostic operation layer.
 *
 * One place declares each capability (zod-typed input/output, description,
 * behaviour hints, and a `handler(args, ctx) => core` body). The MCP server, the
 * REST API, and the code-mode sandbox are all thin projections of this registry,
 * so they can never drift in behaviour or surface. No `@modelcontextprotocol/sdk`
 * dependency: this package sits below every transport.
 */
export * from "./base.js";
export * from "./operations/index.js";
export * from "./signatures.js";
