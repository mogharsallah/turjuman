# @turjuman/aws-cdk

AWS CDK construct for [Turjuman](https://github.com/mogharsallah/turjuman) — the
self-hosted, MCP-driven translation backend as a composable, props-driven stack.

It declares the whole topology: the retained single-table DynamoDB store (PK/SK +
GSI1/2/3 + Streams) and up to three Lambda Function URLs — the always-on **MCP
server**, the optional **REST API** (for the developer CLI/CI), and the optional
**DynamoDB Streams → webhook dispatcher**. The Lambda handlers are pre-built and
**vendored into this package** (`lambda/{mcp,api,webhook}/`), so it is
standalone-installable: `npm i @turjuman/aws-cdk aws-cdk-lib constructs` gives you
everything needed to synth and deploy, with no dependency on the Turjuman source
packages.

To self-host, instantiate `TurjumanStack` in a small CDK app and run `cdk deploy`,
then `turjuman bootstrap` to create the first owner — see the
[self-hosting guide](https://github.com/mogharsallah/turjuman/blob/main/docs/self-hosting.mdx).
Or compose the reusable `Turjuman` construct into your **own** CDK app.

## Usage

```ts
import { App } from "aws-cdk-lib";
import { TurjumanStack } from "@turjuman/aws-cdk";

const app = new App();
new TurjumanStack(app, "Turjuman", {
  // every option is optional; defaults reproduce the standard stack
  table: { pointInTimeRecovery: true, deletionProtection: true },
  webhook: { enabled: false }, // drop the webhook surface
});
```

Or drop the reusable construct into an existing stack:

```ts
import { Turjuman } from "@turjuman/aws-cdk";

const turjuman = new Turjuman(this, "Turjuman", { corsAllowOrigins: ["https://example.com"] });
turjuman.mcpUrl.url; // exposed for outputs / wiring
```

Then `cdk deploy` in a bootstrapped account (`cdk bootstrap` once per
account/region). `aws-cdk-lib` and `constructs` are peer dependencies — you own
the CDK version.

## Options

See `TurjumanProps` / `TurjumanStackProps`. Highlights: `table` (billing mode,
provisioned capacity, point-in-time recovery, deletion protection), per-function
`architecture`/`memorySize`/`timeout` (via `functionDefaults`, `mcp`, `api`,
`webhook`), `corsAllowOrigins`, `vpc`, and `api`/`webhook` `enabled` toggles.
Defaults reproduce the on-demand, streamed, retained single-table topology.

The DynamoDB table is declared with `RemovalPolicy.RETAIN` and a deliberately
fixed construct id, so a refactor can never make CloudFormation replace (and thus
wipe) your data.
