# @turjuman/api

## 0.2.0

### Minor Changes

- 5fe0dff: Redesign the AWS deploy around a published, composable CDK construct + pre-bundled Lambda assets + the standard CDK bootstrap.

  - New `@turjuman/aws-cdk`: a props-driven `Turjuman` construct (+ `TurjumanStack` wrapper) that is the single source of the deploy topology — DynamoDB (on-demand/provisioned, optional PITR + deletion protection, retained) and up to three Lambda Function URLs with `api`/`webhook` toggles and per-function tuning. The data-critical table keeps a stable identity; all other ids are idiomatic CDK.
  - `@turjuman/mcp-server` and `@turjuman/api` now ship pre-bundled, self-contained Lambda assets (`lambda/handler.mjs`, `lambda-webhook/webhook.mjs`) and expose them via package `exports`, so the construct resolves them with `Code.fromAsset` — no bundling at deploy time.
  - The deploy CLI moved from `@turjuman/deploy` to **`@turjuman/aws-deploy`** (bin `turjuman-aws-deploy`). It now deploys the construct with the standard CDK bootstrap + asset pipeline (self-bootstrapping unless `--skip-bootstrap`), stores the canonical config in SSM (`/turjuman/<stack>/deploy-config`) with `turjuman.deploy.json` as a local cache, and adds non-interactive `--set` / `--enable` / `--disable` overrides plus new table knobs. The bespoke esbuild/S3-upload machinery is gone.

### Patch Changes

- @turjuman/core@0.2.0
- @turjuman/formats@0.2.0
