# @turjuman/mcp-server

The MCP server for [Turjuman](https://github.com/mogharsallah/turjuman) — open-source, self-hosted
translation management.

A stateless [Model Context Protocol](https://modelcontextprotocol.io) server over Streamable HTTP
(one POST = one JSON-RPC message), packaged to run as an AWS Lambda Function URL. An LLM/agent
connects to it with a bearer API key and does the translating; all business logic and authorization
live in [`@turjuman/core`](https://github.com/mogharsallah/turjuman/tree/main/packages/core).

It's normally deployed for you by
[`@turjuman/aws-deploy`](https://github.com/mogharsallah/turjuman/tree/main/packages/aws-deploy),
which ships this package's pre-bundled Lambda asset (`lambda/handler.mjs`). See the
[architecture docs](https://github.com/mogharsallah/turjuman/blob/main/docs/concepts/architecture.mdx)
for the request flow.

## License

MIT
