# @turjuman/core

## 0.3.0

### Minor Changes

- cf86fd2: Unify structured logging across all three Lambdas. The MCP server's one-JSON-line-per-request logger (`logInfo`/`logError`/`errorInfo`) moves into `@turjuman/core` and is now shared:

  - **REST API** emits one `api_request` access line per request (`requestId`, `method`, `path`, `status`, `keyId`, `ms`) — the mirror of the MCP `mcp_request` line — so a single CloudWatch Logs Insights query spans both transports. Unhandled errors log a structured `api_unhandled` line with the stack (server-side only) instead of a bare `console.error` string.
  - **Webhook dispatcher** replaces its interpolated `console.error` strings with structured `webhook_delivered` / `webhook_delivery_failed` lines (`projectId`, `event`, `webhookId`, `status`/`reason`) plus a per-batch `webhook_batch` summary.

  All three now share one field vocabulary, so operators can query the whole stack the same way. Purely additive to the operator-facing logs; no API or wire change.

### Patch Changes

- @turjuman/schema@0.3.0

## 0.2.0

### Patch Changes

- @turjuman/schema@0.2.0
