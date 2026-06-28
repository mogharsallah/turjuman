# @turjuman/mcp-server

## 0.3.0

### Patch Changes

- cf86fd2: Unify structured logging across all three Lambdas. The MCP server's one-JSON-line-per-request logger (`logInfo`/`logError`/`errorInfo`) moves into `@turjuman/core` and is now shared:

  - **REST API** emits one `api_request` access line per request (`requestId`, `method`, `path`, `status`, `keyId`, `ms`) — the mirror of the MCP `mcp_request` line — so a single CloudWatch Logs Insights query spans both transports. Unhandled errors log a structured `api_unhandled` line with the stack (server-side only) instead of a bare `console.error` string.
  - **Webhook dispatcher** replaces its interpolated `console.error` strings with structured `webhook_delivered` / `webhook_delivery_failed` lines (`projectId`, `event`, `webhookId`, `status`/`reason`) plus a per-batch `webhook_batch` summary.

  All three now share one field vocabulary, so operators can query the whole stack the same way. Purely additive to the operator-facing logs; no API or wire change.

- Updated dependencies [cf86fd2]
  - @turjuman/core@0.3.0
  - @turjuman/sandbox@0.3.0
  - @turjuman/sdk@0.3.0
  - @turjuman/knowledge@0.3.0

## 0.2.0

### Minor Changes

- 5fe0dff: Redesign the AWS deploy around a published, composable CDK construct + pre-bundled Lambda assets + the standard CDK bootstrap.

  - New `@turjuman/aws-cdk`: a props-driven `Turjuman` construct (+ `TurjumanStack` wrapper) that is the single source of the deploy topology — DynamoDB (on-demand/provisioned, optional PITR + deletion protection, retained) and up to three Lambda Function URLs with `api`/`webhook` toggles and per-function tuning. The data-critical table keeps a stable identity; all other ids are idiomatic CDK.
  - `@turjuman/mcp-server` and `@turjuman/api` now ship pre-bundled, self-contained Lambda assets (`lambda/handler.mjs`, `lambda-webhook/webhook.mjs`) and expose them via package `exports`, so the construct resolves them with `Code.fromAsset` — no bundling at deploy time.
  - The deploy CLI moved from `@turjuman/deploy` to **`@turjuman/aws-deploy`** (bin `turjuman-aws-deploy`). It now deploys the construct with the standard CDK bootstrap + asset pipeline (self-bootstrapping unless `--skip-bootstrap`), stores the canonical config in SSM (`/turjuman/<stack>/deploy-config`) with `turjuman.deploy.json` as a local cache, and adds non-interactive `--set` / `--enable` / `--disable` overrides plus new table knobs. The bespoke esbuild/S3-upload machinery is gone.

### Patch Changes

- @turjuman/core@0.2.0
