# @turjuman/aws-cdk

## 0.3.0

### Minor Changes

- e45654a: Add a dev/LocalStack-only `hotReload` prop to the `Turjuman` construct. When set, each function's code is served from LocalStack's magic `hot-reload` S3 bucket (via `Code.fromBucket`) instead of a packaged asset, so a watching bundler can update the running Lambda without a redeploy. It is inert when unset, so production deploys are unaffected. This powers the `npm run dev` local dev loop.

## 0.2.0

### Minor Changes

- 5fe0dff: Redesign the AWS deploy around a published, composable CDK construct + pre-bundled Lambda assets + the standard CDK bootstrap.

  - New `@turjuman/aws-cdk`: a props-driven `Turjuman` construct (+ `TurjumanStack` wrapper) that is the single source of the deploy topology — DynamoDB (on-demand/provisioned, optional PITR + deletion protection, retained) and up to three Lambda Function URLs with `api`/`webhook` toggles and per-function tuning. The data-critical table keeps a stable identity; all other ids are idiomatic CDK.
  - `@turjuman/mcp-server` and `@turjuman/api` now ship pre-bundled, self-contained Lambda assets (`lambda/handler.mjs`, `lambda-webhook/webhook.mjs`) and expose them via package `exports`, so the construct resolves them with `Code.fromAsset` — no bundling at deploy time.
  - The deploy CLI moved from `@turjuman/deploy` to **`@turjuman/aws-deploy`** (bin `turjuman-aws-deploy`). It now deploys the construct with the standard CDK bootstrap + asset pipeline (self-bootstrapping unless `--skip-bootstrap`), stores the canonical config in SSM (`/turjuman/<stack>/deploy-config`) with `turjuman.deploy.json` as a local cache, and adds non-interactive `--set` / `--enable` / `--disable` overrides plus new table knobs. The bespoke esbuild/S3-upload machinery is gone.

### Patch Changes

- Updated dependencies [5fe0dff]
  - @turjuman/mcp-server@0.2.0
  - @turjuman/api@0.2.0
