# @turjuman/cli

The `turjuman` developer CLI for [Turjuman](https://github.com/mogharsallah/turjuman) — open-source,
self-hosted translation management driven through an MCP server.

The CLI handles the deterministic, file-side half of the workflow: pulling translations down into
your repo's locale files, pushing source strings up, and building release bundles — in your editor
and in CI. The translating itself happens through the MCP server (an LLM/agent); this tool never
talks to AWS and stays a lean install (no AWS SDK).

## Install

```bash
npm install -g @turjuman/cli   # or: npx @turjuman/cli <command>
```

## Usage

```bash
turjuman login --url <api-url> --key <api-key>   # store machine-local credentials
turjuman init                                    # scaffold turjuman config for this repo
turjuman pull                                    # download translations into locale files
turjuman push                                    # upload source keys/strings
turjuman build                                   # build release bundles
turjuman check                                   # run QA checks
turjuman formats                                 # list supported file formats
```

Add `--json` to most commands for machine-readable output (handy in CI). See the
[CLI reference](https://github.com/mogharsallah/turjuman/blob/main/docs/reference/cli-commands.mdx) for
the full command set, multi-target config, and push/pull semantics.

## License

MIT
