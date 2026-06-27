<p align="center">
  <img src="assets/turjuman-mark.svg" alt="Turjuman" width="96" height="96" />
</p>

# Turjuman

**Open-source, self-hosted translation management — managed by your AI agent.**

Turjuman is a lightweight, open-source alternative to commercial translation-management
SaaS. Instead of a heavy web dashboard, you manage projects, keys, locales and
translations through an **MCP server** connected to Claude Code (or any MCP client/agent).
A thin **developer CLI** handles the deterministic file work — pulling/pushing locale
files in your repo and CI.

It runs on a **serverless AWS stack (Lambda + DynamoDB)** that costs ~nothing to host and
fits comfortably in the free tier. No always-on servers, no Cognito.

```
Claude Code / agent ──Streamable HTTP + API key──┐
Developer CLI / CI ──REST + API key──────────────┤
                                                 ▼
                          Lambda Function URLs ──► DynamoDB (single table)
```

## Why MCP-first?

Translation management is mostly conversation + judgement: "add a French locale", "translate
the untranslated checkout strings", "what does `cart.empty` say in German?". An agent with the
right tools does this naturally. The connected LLM **does the translating itself** — there's
no separate machine-translation engine to pay for or configure.

The CLI exists for the things you should *not* hand to an LLM: deterministically exporting a
JSON/YAML file, downloading translations, and syncing them in CI.

## Features (v1)

- **MCP server** with 36 tools: projects, locales, keys (with descriptions/context), translations,
  bulk fill, review workflow, and full user/member/API-key administration (incl. key revocation).
- **First-class RBAC.** Global roles (`OWNER`/`ADMIN`/`MEMBER`) + per-project roles
  (`MANAGER`/`EDITOR`/`DEVELOPER`/`VIEWER`). High-privilege users manage everyone else's access.
- **Glossary + translation memory**, and **webhooks** (HMAC-signed, via DynamoDB Streams) for change events.
- **API-key auth** — simple bearer tokens, stored hashed. (OAuth/Cognito is a future option.)
- **Developer CLI** — `login`, `init`, `pull`, `push`, `build` with multi-target config and adapters
  for JSON (nested/flat), YAML, Flutter ARB, Java `.properties`, CSV, Android `strings.xml`, and iOS
  `.strings`/`.stringsdict` (ICU-canonical plurals converted to each format's native form).
- **DynamoDB single-table design**, on-demand billing. Multi-tenant-ready (`orgId` on every record).

## Repository layout

| Package | What it is |
|---|---|
| `packages/core` | Domain model, DynamoDB repository, RBAC, services, format adapters (the shared brain) |
| `packages/mcp-server` | Stateless Streamable HTTP MCP server → Lambda |
| `packages/api` | REST API for the CLI/CI → Lambda, plus the webhook dispatcher |
| `packages/cli` | The `turjuman` developer CLI (locale-file sync + first-owner `bootstrap`) |

## Try it locally

The fastest way to see Turjuman work — everything runs against a local
[LocalStack](https://www.localstack.cloud/) (needs Docker + Node 24+), no cloud account needed.
Turjuman uses [pnpm](https://pnpm.io) (pinned via `package.json`'s `packageManager` field); run
`corepack enable` once to activate it.

```bash
pnpm install && pnpm run build
pnpm run localstack:up            # start the shared LocalStack on :4566
cp .env.example .env             # point the toolchain at LocalStack

# deploy into LocalStack with hot reload; prints the MCP/REST URLs + a fresh API key
pnpm run dev
```

`pnpm run dev` runs the real Lambda runtime in LocalStack (so DynamoDB Streams → webhooks fire too) and
hot-reloads your edits. Point your MCP client at the printed MCP URL with the printed API key and start
talking to it.

## Self-host on AWS

> **Status:** the CDK stack is conventional but has **not yet been verified end-to-end against a
> live AWS account** (see [ROADMAP](ROADMAP.md)). Use the local path above to evaluate; treat the
> cloud deploy as beta and please report issues.

### 1. Deploy to your AWS account

Instantiate the `TurjumanStack` in a tiny CDK app and deploy it with the AWS CDK CLI. The construct
vendors its Lambda bundles, so there's no SAM CLI and no repo clone (see
[Self-hosting](docs/self-hosting/overview.mdx) for the full walkthrough and config):

```bash
npm install @turjuman/aws-cdk aws-cdk-lib constructs
cdk bootstrap   # once per account+region (standard CDK bootstrap)
cdk deploy      # prints McpUrl / ApiUrl / TableName as stack outputs
```

`@turjuman/aws-cdk` is standalone-installable, so the day-to-day `turjuman` developer CLI stays a
lean, AWS-free install.

### 2. Your first owner + API key

Once the stack is up, create the first owner over HTTP and capture its key — printed **once**, and
saved to `~/.turjuman/auth.json` so you're logged in:

```bash
turjuman bootstrap --url <ApiUrl> --email you@example.com --name "Your Name"
```

It refuses to create a second owner once the deployment has users (returns `409`), so re-running it
is safe.

### 3. Connect Claude Code (MCP)

Add to your `.mcp.json` (see `.mcp.json.example`):

```json
{
  "mcpServers": {
    "turjuman": {
      "type": "http",
      "url": "<McpUrl>",
      "headers": { "Authorization": "Bearer <your-api-key>" }
    }
  }
}
```

> **Keep your key out of version control.** `.mcp.json` is often committed — prefer referencing the
> token via an environment variable / secret manager rather than pasting the literal key. If a key
> ever leaks, revoke it immediately with the `revoke_api_key` tool.

Then just ask: *"Create a project called Web App with base locale en, add fr and es, and
translate everything into French."*

### 4. Sync files in your repo (CLI)

```bash
pnpm dlx turjuman login --url <ApiUrl> --key <your-api-key>
pnpm dlx turjuman init --project <proj_id> --format json-nested --path "locales/{locale}.json"
pnpm dlx turjuman pull     # write locale files from Turjuman
pnpm dlx turjuman push     # upload source keys / translations
```

## Documentation

The full documentation lives in [`docs/`](docs/) and is published as a documentation site with
[Mintlify](https://mintlify.com) — one source that serves human readers, external agents (Mintlify
auto-generates `llms.txt` / `llms-full.txt` and an "open in Claude/ChatGPT" menu per page), and the
agents working in this repo. Start here:

- Get started: [Introduction](docs/introduction.mdx) · [Quickstart](docs/quickstart.mdx) (deploy to AWS) · [Try it locally](docs/guides/try-it-locally.mdx) (no AWS)
- Concepts: [Why MCP-first](docs/concepts/why-mcp-first.mdx) · [Architecture](docs/concepts/architecture.mdx) · [Lifecycle](docs/concepts/lifecycle.mdx) · [Roles & permissions](docs/concepts/roles-and-permissions.mdx) · [How agents use Turjuman](docs/concepts/how-agents-use-turjuman.mdx)
- Guides: [Translate with MCP](docs/guides/translate-with-mcp.mdx) · [Code mode](docs/guides/code-mode.mdx) · [Sync with the CLI](docs/guides/sync-with-cli.mdx) · [Quality checks](docs/guides/quality-checks.mdx) · [Webhooks](docs/guides/webhooks.mdx) · [Connect Claude Code](docs/guides/connect-claude-code.mdx)
- Reference: [MCP tools](docs/reference/mcp-tools.mdx) · [CLI commands](docs/reference/cli-commands.mdx) · [REST API](docs/reference/rest-api.mdx) · [File formats](docs/reference/file-formats.mdx) · [QA checks](docs/reference/qa-checks.mdx) · [Glossary](docs/reference/glossary.mdx)
- Self-hosting: [Overview](docs/self-hosting/overview.mdx) · [Deploy to AWS](docs/self-hosting/deploy.mdx) · [Configuration](docs/self-hosting/configuration.mdx) · [Security & API keys](docs/self-hosting/security.mdx)
- [Contributing](CONTRIBUTING.md) · [Roadmap](ROADMAP.md)

## Development

```bash
pnpm install
pnpm run build
pnpm test            # unit tests (hermetic)

# integration tests against an emulated AWS (LocalStack DynamoDB):
pnpm run localstack:up && pnpm run test:integration && pnpm run localstack:down

# full deployed end-to-end (SAM stack on LocalStack: Lambda Function URLs +
# the real DynamoDB Streams -> webhook flow). Just needs Docker:
pnpm run test:e2e
```

### Formatting & linting

Formatting and linting are handled by [Biome](https://biomejs.dev) (a single, fast
Rust-based replacement for Prettier + ESLint), configured in `biome.json`:

```bash
pnpm run check         # format + lint, report only
pnpm run check:write   # apply formatting + safe lint fixes
pnpm run format        # format only
pnpm run lint          # lint only
```

You rarely run these by hand. A `pre-commit` hook auto-formats staged files, CI
runs `biome ci .`, and — since this repo is developed primarily with Claude Code —
a `PostToolUse` hook (`.claude/hooks/biome-format.sh`) auto-formats each file as
the agent edits it. The generated `docs/api-reference/openapi.json` snapshot is
owned by `gen:openapi` and excluded from Biome.

See [Contributing](CONTRIBUTING.md) for the full testing guide (unit,
LocalStack integration, and deployed end-to-end), which also runs in CI.

## License

MIT
