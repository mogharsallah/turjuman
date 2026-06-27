# @turjuman/deploy-internal

**Internal, unpublished.** The small set of deploy primitives the Turjuman repo's
own dev/e2e scripts need — extracted from the former `@turjuman/aws-deploy` CLI when
that product was removed in favour of the self-contained
[`@turjuman/aws-cdk`](../aws-cdk) construct + `turjuman bootstrap`.

It exposes two things, consumed by `scripts/{dev,e2e}-{deploy,teardown}.mjs`:

- `deployStack(opts)` — synthesize the `TurjumanStack` from `@turjuman/aws-cdk` and
  deploy it with the AWS CDK programmatic toolkit (self-bootstrapping unless
  `skipBootstrap`). Used to deploy into LocalStack.
- `describeStack` / `findManagedStacks` / `findStackResource` / `deleteStack` /
  `STACK_TAGS` — thin CloudFormation helpers for inspecting and tearing those
  stacks down.

There is **no CLI and no public API here** — to self-host Turjuman, use the
`@turjuman/aws-cdk` construct directly (see `docs/self-hosting.mdx`).
