# @turjuman/schema

The pure, AWS-free core of [Turjuman](https://github.com/mogharsallah/turjuman) — open-source,
self-hosted translation management.

This package is the shared brain the rest of Turjuman builds on:

- the **domain model** — every entity defined once as a zod schema, with its TypeScript type
  derived via `z.infer` (`Project`, `Locale`, `TranslationKey`, `Translation`, …);
- **input validation** schemas and helpers (`parse`, the request-body schemas);
- the **wire shapes** that cross the MCP/REST boundary;
- the **RBAC policy** matrix (`canOnOrg`, `canOnProject`, …);
- **ICU plural** helpers (`parseIcuPlural`, `buildIcuPlural`, …); and
- the **QA check** engine, exposed at the `@turjuman/schema/qa` subpath.

It deliberately pulls in **no AWS SDK** — the DynamoDB repository and the stateful services live in
[`@turjuman/core`](https://github.com/mogharsallah/turjuman/tree/main/packages/core), which depends on this
package. File-format adapters live in
[`@turjuman/formats`](https://github.com/mogharsallah/turjuman/tree/main/packages/formats).

```ts
import { canOnOrg, parseIcuPlural, type Project } from "@turjuman/schema";
import { runChecks } from "@turjuman/schema/qa";
```

## License

MIT
