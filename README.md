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
| `packages/cli` | The `turjuman` developer CLI (incl. the AWS CDK deployer in `src/deploy/`) |

## Try it locally

The fastest way to see Turjuman work — everything runs against a local
[LocalStack](https://www.localstack.cloud/) (needs Docker + Node 20.12+), no cloud account needed:

```bash
npm install && npm run build
npm run stack:up                 # start the shared LocalStack on :4566
cp .env.example .env             # point the dev servers at LocalStack

# create the table + first owner, and print your API key
npm run dev:setup you@example.com "You"

# start both servers with hot reload (MCP :3000, REST :4000)
npm run dev
```

Point your MCP client at `http://localhost:3000/` with the printed API key (see below) and start
talking to it. For the high-fidelity loop that runs the real Lambda runtime (and fires webhooks), use
`npm run dev:lambda` — see [contributing](docs/contributing.mdx).

## Self-host on AWS

> **Status:** the SAM stack is conventional but has **not yet been verified end-to-end against a
> live AWS account** (see [ROADMAP](ROADMAP.md)). Use the local path above to evaluate; treat the
> cloud deploy as beta and please report issues.

### 1. Deploy to your AWS account

One command self-bootstraps the CDK environment, deploys the CloudFormation stack from pre-bundled
Lambda assets, and creates your first owner — no SAM CLI, no clone needed (see
[Self-hosting](docs/self-hosting.mdx) for options):

```bash
npx @turjuman/aws-deploy deploy   # interactive; prints McpUrl/ApiUrl and your API key
```

Self-hosting ships as a separate `@turjuman/aws-deploy` package (binary `turjuman-aws-deploy`) so the
day-to-day `turjuman` developer CLI stays a lean, AWS-free install.

### 2. Your first owner + API key

`turjuman-aws-deploy deploy` creates the first owner at the end and prints the API key **once** (also
saved to `~/.turjuman/auth.json`, so you're logged in). It refuses to create a second owner once the
org has users, so re-running `deploy` to update the stack is safe.

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
npx turjuman login --url <ApiUrl> --key <your-api-key>
npx turjuman init --project <proj_id> --format json-nested --path "locales/{locale}.json"
npx turjuman pull     # write locale files from Turjuman
npx turjuman push     # upload source keys / translations
```

## Documentation

The full documentation lives in [`docs/`](docs/) and is published as a documentation site with
[Mintlify](https://mintlify.com) — one source that serves human readers, external agents (Mintlify
auto-generates `llms.txt` / `llms-full.txt` and an "open in Claude/ChatGPT" menu per page), and the
agents working in this repo. Start here:

- [Introduction](docs/index.mdx) · [Quickstart](docs/quickstart.mdx) (run locally, no AWS) · [Self-hosting](docs/self-hosting.mdx) (deploy on AWS)
- [Architecture](docs/concepts/architecture.mdx) · [Roles & permissions](docs/concepts/roles-and-permissions.mdx) · [Lifecycle](docs/concepts/lifecycle.mdx)
- [Translate with MCP](docs/guides/translate-with-mcp.mdx) · [Sync with the CLI](docs/guides/sync-with-cli.mdx) · [Quality checks](docs/guides/quality-checks.mdx) · [Webhooks](docs/guides/webhooks.mdx)
- Reference: [MCP tools](docs/reference/mcp-tools.mdx) · [CLI commands](docs/reference/cli-commands.mdx) · [File formats](docs/reference/file-formats.mdx) · [QA checks](docs/reference/qa-checks.mdx)
- [Contributing](docs/contributing.mdx) · [Roadmap](ROADMAP.md)

## Development

```bash
npm install
npm run build
npm test            # unit tests (hermetic)

# integration tests against an emulated AWS (LocalStack DynamoDB):
npm run e2e:up && npm run test:integration && npm run e2e:down

# full deployed end-to-end (SAM stack on LocalStack: Lambda Function URLs +
# the real DynamoDB Streams -> webhook flow). Just needs Docker:
npm run test:e2e
```

See [Contributing](docs/contributing.mdx) for the full testing guide (unit,
LocalStack integration, and deployed end-to-end), which also runs in CI.

## License

MIT
