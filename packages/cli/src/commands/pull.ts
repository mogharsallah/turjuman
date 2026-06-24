import type { Command } from "commander";
import * as formats from "@turjuman/formats";
import type { ApiClient } from "../client.js";
import type { ProjectConfig } from "../config.js";
import type { CliDeps } from "../deps.js";
import type { OutputSink } from "../output.js";
import { type FileWriter, filePath, writeFileEnsured } from "../paths.js";

export interface PullOpts {
  working?: boolean;
  excludeStale?: boolean;
}

interface PulledFile {
  path: string;
  locale: string;
  namespace: string;
  format: string;
  entries: number;
}

/** Download translations and write one file per (locale, target). */
export async function runPull(
  api: ApiClient,
  config: ProjectConfig,
  opts: PullOpts,
  out: OutputSink,
  writeFile: FileWriter = writeFileEnsured,
): Promise<PulledFile[]> {
  const { locales } = await api.listLocales(config.projectId);
  const files: PulledFile[] = [];
  for (const locale of locales) {
    const { entries } = await api.exportBundle(config.projectId, locale.code, {
      working: opts.working,
      excludeStale: opts.excludeStale,
    });
    for (const target of config.targets) {
      const ns = target.namespace ?? "default";
      const adapter = formats.getAdapter(target.format);
      const items = entries
        .filter((e) => e.namespace === ns)
        .map((e) => ({ key: e.key, value: e.value, description: e.description, plural: e.plural }));
      const out_path = filePath(target.path, locale.code);
      writeFile(out_path, adapter.serialize(items, { locale: locale.code }));
      out.line(`Wrote ${items.length} entries -> ${out_path}`);
      files.push({ path: out_path, locale: locale.code, namespace: ns, format: target.format, entries: items.length });
    }
  }
  out.result({ command: "pull", working: Boolean(opts.working), excludeStale: Boolean(opts.excludeStale), files });
  return files;
}

export function registerPull(program: Command, deps: CliDeps, name: string, description: string): void {
  program
    .command(name)
    .description(description)
    .option("--working", "Ship the in-progress (working) value instead of the approved snapshot")
    .option("--exclude-stale", "Skip translations whose source value has since changed")
    .action(async (opts: { working?: boolean; excludeStale?: boolean }) => {
      const config = deps.loadConfig();
      await runPull(deps.clientFactory(), config, opts, deps.out);
    });
}
