# @turjuman/aws-deploy

Self-host tooling (`turjuman-aws-deploy`) for
[Turjuman](https://github.com/mogharsallah/turjuman) — open-source, self-hosted
translation management.

Deploys the whole Turjuman stack to your own AWS account in one command: a single
DynamoDB table and up to three Lambda Function URLs. The topology is the
[`@turjuman/aws-cdk`](https://github.com/mogharsallah/turjuman/tree/main/packages/aws-cdk)
construct, deployed via the CDK programmatic toolkit. The CLI **self-bootstraps**
the standard CDK environment (the shared `CDKToolkit` stack) on first run, so it
stays a one-liner — pass `--skip-bootstrap` if you bootstrap accounts yourself.

The Lambda code ships pre-bundled inside `@turjuman/mcp-server` and `@turjuman/api`
(published assets), so — unlike before — you no longer need to build from a clone:

```bash
npx @turjuman/aws-deploy deploy     # interactive: stack name, region, options, first owner
```

The canonical config is stored in an AWS SSM parameter
(`/turjuman/<stack>/deploy-config`), so a redeploy works from any machine or CI;
`turjuman.deploy.json` is just a local cache. Re-running `deploy` is the one path
for any change:

```bash
npx @turjuman/aws-deploy deploy --disable webhook       # remove a surface
npx @turjuman/aws-deploy deploy --set mcp.memorySize=512 # tweak a single knob
```

See the [self-hosting guide](https://github.com/mogharsallah/turjuman/blob/main/docs/self-hosting.mdx)
for `deploy`, `status`, `teardown` and `bootstrap`.

## License

MIT
