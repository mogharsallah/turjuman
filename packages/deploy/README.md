# @turjuman/deploy

Self-host tooling (`turjuman-deploy`) for [Turjuman](https://github.com/mogharsallah/turjuman) —
open-source, self-hosted translation management.

Deploys the whole Turjuman stack to your own AWS account in one command: a single DynamoDB table and
three Lambda Function URLs, declared with the AWS CDK and deployed via the CDK programmatic toolkit
(no SAM CLI, no `cdk bootstrap`).

> **Run it from a clone of the repo.** `turjuman-deploy` bundles the Lambda functions from source at
> deploy time, so it builds the MCP server and REST API out of this monorepo:
>
> ```bash
> npm install && npm run build
> npx @turjuman/deploy deploy     # interactive: stack name, region, options, first owner
> ```

See the [self-hosting guide](https://github.com/mogharsallah/turjuman/blob/main/docs/self-hosting.mdx)
for `deploy`, `status`, `teardown` and `bootstrap`.

## License

MIT
