# ADR 0001 — Code-Mode MCP via a transport-agnostic SDK + sandbox

- Status: accepted (implementation in progress)
- Date: 2026-06-25

## Context

The MCP server exposes ~45 tools. With classic MCP, every tool's name +
description + JSON Schema is injected into the model's context every turn — a
large, permanent token tax. The industry fix ("code execution with MCP",
Anthropic/Cloudflare) is to expose a tiny surface (`search_sdk` + `run_code`),
let the model write TypeScript against a typed SDK, run that code in a sandbox
whose only capability is the SDK, and return only the final result to the model.

This work also pays down an architectural debt: the MCP tool definitions had
become the de facto entry point for business capability. We make capability
**transport-agnostic** so MCP, the REST API, and the sandbox are all thin, equal
projections of one registry.

## Decision

1. **Two new packages.**
   - `@turjuman/sdk` — consumer-agnostic *operation definitions* (zod
     input/output, description, behaviour hints, `handler(args, ctx) => core`).
     **No `@modelcontextprotocol/sdk` dependency.**
   - `@turjuman/sandbox` — the isolate execution engine, wireable into any
     transport.
2. **MCP and the REST API become thin projections of `@turjuman/sdk`.** The
   hand-kept MCP `ToolDef` arrays and (later) the hand-written REST routes are
   deleted and replaced by generated projections of `OPERATIONS`.
3. **No external HTTP client SDK.** The "SDK" is the server-side operation layer;
   the agent's in-sandbox `turjuman.*` is the generated client-facing face of the
   same definitions.
4. **Sandbox = Model 1 (host broker), run IN-PROCESS.** The guest has no
   network/fs/env; each `turjuman.X(args)` call is a plain in-process call to
   `OPERATIONS_BY_NAME["X"].handler(args, ctx)` — the same handler a normal tool
   or route runs. Moving the isolate into a grant-less Lambda is a deferred
   hardening variant, swappable without changing the SDK or the agent contract.
5. **Two mutually-exclusive MCP modes per connection:** *Code mode* (`search_sdk`
   + `run_code`) **xor** *Classic mode* (all operations as MCP tools).
6. **OpenAPI `$ref` integrity is a hard requirement.** The REST projection must
   keep emitting shared schemas once under `components.schemas` and `$ref`-ing
   them for both request and response — never inlining/duplicating.

## Package layering

```
@turjuman/schema   zod domain model, validation, rbac, plural, qa     (AWS-free)
   ▲
@turjuman/core     services + single-table repository                 (the brain)
   ▲
@turjuman/sdk      OPERATIONS over core (definitions, MCP-free)        (NEW)
   ▲
@turjuman/sandbox  isolate engine; turjuman.* stubs of OPERATIONS      (NEW)
   ▲                         ▲
@turjuman/mcp-server   @turjuman/api     thin projections (tool / route)
```

`OpContext` (`{ service, actor, user, requestId }`) and an MCP-free `OpAnnotations`
type live in `@turjuman/sdk`; the MCP projection maps `OpAnnotations` onto MCP's
structurally-identical `ToolAnnotations`.

## Request flow (in-process, fewest hops)

From the agent it is one request/response, identical to calling a single tool;
inside, the code chains many SDK calls with zero extra network hops:

1. Agent → MCP `run_code({code})` + bearer key (1 network call).
2. MCP authenticates → authenticated `ctx`.
3. MCP calls `sandbox.runCode({ code, ctx })`; the isolate runs in-process; the
   guest has no ambient capability.
4. Each `turjuman.X(args)` → host bridge → `OPERATIONS_BY_NAME["X"].handler(args,
   ctx)` → core (no network).
5. MCP returns only the final result (1 network call back).

RBAC is enforced identically to a normal tool call (the bridge passes the same
authenticated `ctx`); untrusted code never sees the token or `ctx`. The residual
risk is an isolate escape, mitigated by the WASM memory boundary and, if ever
required, the grant-less-Lambda hardening variant.

## OpenAPI `$ref` integrity rules (REST projection)

1. **Reuse, never redefine** the `.openapi({ ref })`-annotated schemas from
   `@turjuman/schema`, so `resolver()`/`validator()` emit `$ref`s.
2. **Split flat operation inputs for REST** via the `http.params` binding (path/
   query vs body); name the body sub-schema so the request type is a component.
3. **One definition per shape**, names unique; responses keep the shared
   `jsonResponse`/`resolver` + `errorResponses` helpers.
4. **Guard it** with the extended `router.test.ts` `$ref` test + the
   `gen:openapi` snapshot drift check.

## Implementation status

- **Phase 1 — Extract `@turjuman/sdk` + refactor MCP to a projection.** Done. The
  operation registry lives in `@turjuman/sdk`; the MCP server's hardcoded
  `ToolDef` arrays are deleted and classic mode is generated from `OPERATIONS`.
- **Phase 2 — `@turjuman/sandbox` engine.** Done. `runCode({ code, ctx, limits })`
  runs untrusted code in a per-run QuickJS-WASM isolate; `turjuman.<operation>(args)`
  stubs are generated from `OPERATIONS` and bridge in-process to
  `op.handler(args, ctx)` via `createOpDispatcher`. CPU (wall-clock), memory,
  output size, and bridge-call count are bounded. Engine note: QuickJS-emscripten
  *asyncify* proved too fragile for our bridge (a host function must never
  throw/reject, and many sequential asyncified calls corrupt the runtime), so the
  engine uses the **synchronous QuickJS context + deferred-promise** pattern
  instead — the bridge returns a guest promise and the host drives
  `executePendingJobs` to settlement. Each run also gets a **fresh WASM module**
  so a timed-out/OOM run can be abandoned (GC reclaims it) with no shared state to
  corrupt. Security crux covered by unit tests (no `fetch`/`process`/`require`/
  timers in the guest; host `ctx`/token unreachable; infinite loop hits the time
  cap; oversized output truncated; bridge routes to the right handler with the
  request actor; errors masked at the boundary).
- **Phase 3 — Code-mode MCP tools (`search_sdk` + `run_code`).** Pending.
- **Phase 4 — Refactor the REST API to a projection + coverage tracker + `$ref`
  guard.** Pending.
- **Phase 5 — Docs.** Pending.

## Consequences

- A single source of capability; transports can't drift in behaviour or
  permissions.
- Code mode advertises 2 tools instead of ~45 — a large per-turn token saving.
- The `http` binding on each operation makes REST coverage explicit and
  self-tracking (`operationsMissingHttp()`), replacing a TODO that would rot.
