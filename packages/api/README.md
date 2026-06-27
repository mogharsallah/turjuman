# @turjuman/api

The REST API for [Turjuman](https://github.com/mogharsallah/turjuman) — open-source, self-hosted
translation management.

A [Hono](https://hono.dev) REST API packaged to run as an AWS Lambda Function URL, plus the
DynamoDB-Streams→webhook dispatcher. It serves the [`turjuman` CLI](https://github.com/mogharsallah/turjuman/tree/main/packages/cli)
and CI sync; all business logic and authorization live in
[`@turjuman/core`](https://github.com/mogharsallah/turjuman/tree/main/packages/core). The OpenAPI spec is
served at `GET /v1/openapi.json`.

Its pre-bundled Lambda assets (`lambda/handler.mjs` and `lambda-webhook/webhook.mjs`)
are vendored into
[`@turjuman/aws-cdk`](https://github.com/mogharsallah/turjuman/tree/main/packages/aws-cdk)
and deployed with `cdk deploy` (see
[self-hosting](https://github.com/mogharsallah/turjuman/blob/main/docs/self-hosting.mdx)).

## License

MIT
