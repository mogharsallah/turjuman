# @turjuman/core

The server core of [Turjuman](https://github.com/mogharsallah/turjuman) — open-source, self-hosted
translation management.

This package holds the stateful, server-side half of Turjuman: the single-table **DynamoDB
repository** and the domain **services** (`TurjumanService` and its per-domain sub-services), built on
top of [`@turjuman/schema`](https://github.com/mogharsallah/turjuman/tree/main/packages/schema). It's what
the MCP server, the REST API, and the self-host deployer run on.

The pure, AWS-free domain model, schemas, RBAC policy, ICU helpers and QA engine live in
`@turjuman/schema` (re-exported from here for convenience); file-format adapters live in
[`@turjuman/formats`](https://github.com/mogharsallah/turjuman/tree/main/packages/formats).

```ts
import { TurjumanService, Repository, repositoryFromEnv } from "@turjuman/core";
```

## License

MIT
