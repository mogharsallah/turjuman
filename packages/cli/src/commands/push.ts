import { existsSync, readFileSync } from "node:fs";
import type { Command } from "commander";
import * as formats from "@turjuman/formats";
import type { qa } from "@turjuman/schema";
import type { ApiClient } from "../client.js";
import type { ProjectConfig } from "../config.js";
import type { CliDeps } from "../deps.js";
import type { OutputSink } from "../output.js";
import { filePath } from "../paths.js";
import { printReport, reportPayload } from "../report.js";

export interface PushOpts {
  prune?: boolean;
  dryRun?: boolean;
  check?: boolean;
}

/** Read a file's text, or undefined when it does not exist. Injectable for tests. */
export type FileReader = (path: string) => string | undefined;

const defaultReader: FileReader = (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);

export interface PushResult {
  command: "push";
  dryRun: boolean;
  files: Record<string, unknown>[];
  check?: ReturnType<typeof reportPayload>;
}

/** Upload local source/translation files. The base-locale file is authoritative
 * for keys; other locales contribute translations. Returns the result document
 * plus any QA report (so the caller can set the exit code). */
export async function runPush(
  api: ApiClient,
  config: ProjectConfig,
  opts: PushOpts,
  out: OutputSink,
  readFile: FileReader = defaultReader,
): Promise<{ result: PushResult; report?: qa.QaReport }> {
  const project = await api.getProject(config.projectId);
  const { locales } = await api.listLocales(config.projectId);
  const tag = opts.dryRun ? "[dry-run] " : "";
  const files: Record<string, unknown>[] = [];

  for (const target of config.targets) {
    const ns = target.namespace ?? "default";
    const adapter = formats.getAdapter(target.format);
    for (const locale of locales) {
      const file = filePath(target.path, locale.code);
      const content = readFile(file);
      if (content === undefined) continue;
      const entries = adapter.parse(content, { locale: locale.code });

      if (locale.code === project.baseLocale) {
        if (opts.dryRun) {
          const { keys } = await api.listKeys(config.projectId, ns);
          const remote = new Set(keys.map((k) => k.name));
          const local = new Set(entries.map((e) => e.key));
          const created = [...local].filter((n) => !remote.has(n));
          const removed = opts.prune ? [...remote].filter((n) => !local.has(n)) : [];
          out.line(
            `${tag}${file}: ${created.length} keys would be created, ${
              local.size - created.length
            } existing${opts.prune ? `, ${removed.length} would be pruned` : ""}`,
          );
          files.push({
            path: file,
            locale: locale.code,
            kind: "keys",
            planned: { created: created.length, existing: local.size - created.length, pruned: removed.length },
          });
          continue;
        }
        const res = await api.importKeys(
          config.projectId,
          entries.map((e) => ({
            name: e.key,
            baseValue: e.value,
            description: e.description,
            plural: e.plural,
          })),
          ns,
          // A push is a full-file sync: deprecate keys absent from the source
          // file (restorable), or hard-delete them with --prune.
          { prune: opts.prune, deprecate: !opts.prune },
        );
        out.line(
          `${file}: ${res.created} keys created, ${res.updated} updated, ${res.baseValuesSet} base values set${
            res.reactivated ? `, ${res.reactivated} reactivated` : ""
          }${res.deprecated ? `, ${res.deprecated} deprecated` : ""}${res.deleted ? `, ${res.deleted} pruned` : ""}`,
        );
        files.push({ path: file, locale: locale.code, kind: "keys", ...res });
      } else {
        if (opts.dryRun) {
          const { keys } = await api.listKeys(config.projectId, ns);
          const remote = new Set(keys.map((k) => k.name));
          const skipped = entries.filter((e) => !remote.has(e.key)).length;
          out.line(
            `${tag}${file}: ${entries.length - skipped} ${locale.code} translations would be written${
              skipped ? `, ${skipped} skipped (unknown keys)` : ""
            }`,
          );
          files.push({
            path: file,
            locale: locale.code,
            kind: "translations",
            planned: { wouldWrite: entries.length - skipped, skipped },
          });
          continue;
        }
        const res = await api.importTranslations(
          config.projectId,
          locale.code,
          entries.map((e) => ({ name: e.key, namespace: ns, value: e.value })),
        );
        out.line(
          `${file}: ${res.written} ${locale.code} translations written${
            res.skipped.length ? `, ${res.skipped.length} skipped (unknown keys)` : ""
          }`,
        );
        files.push({ path: file, locale: locale.code, kind: "translations", ...res });
      }
    }
  }

  const result: PushResult = { command: "push", dryRun: Boolean(opts.dryRun), files };
  let report: qa.QaReport | undefined;
  if (opts.check) {
    if (opts.dryRun) out.note("[dry-run] QA checks run against current remote state.");
    report = await api.runChecks(config.projectId, {});
    printReport(report, out);
    result.check = reportPayload(report);
  }
  out.result(result);
  return { result, report };
}

export function registerPush(program: Command, deps: CliDeps): void {
  program
    .command("push")
    .description("Upload local source/translation files. Base-locale file creates/updates keys.")
    .option("--prune", "Delete remote keys (per namespace) absent from the base-locale file")
    .option("--dry-run", "Show what would change without writing anything")
    .option("--check", "After pushing, run QA checks and exit non-zero on any error finding")
    .action(async (opts: { prune?: boolean; dryRun?: boolean; check?: boolean }) => {
      const config = deps.loadConfig();
      const { report } = await runPush(deps.clientFactory(), config, opts, deps.out);
      if (report && report.counts.error > 0) process.exitCode = 1;
    });
}
