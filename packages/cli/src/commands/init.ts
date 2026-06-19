import type { Command } from "commander";
import * as formats from "@turjuman/formats";
import { CONFIG_FILE, type ProjectConfig, saveConfig } from "../config.js";
import type { CliDeps } from "../deps.js";
import type { OutputSink } from "../output.js";

export interface InitOpts {
  project: string;
  format: string;
  path: string;
  namespace?: string;
}

export interface InitResult {
  command: "init";
  file: string;
  config: ProjectConfig;
}

/** Validate the format, build a single-target config, and write it. `saveConfig` is
 * injectable so tests avoid touching disk. Returns the result document. */
export function runInit(
  opts: InitOpts,
  out: OutputSink,
  save: typeof saveConfig = saveConfig,
): InitResult {
  formats.getAdapter(opts.format); // validate
  const config: ProjectConfig = {
    projectId: opts.project,
    targets: [{ format: opts.format, path: opts.path, namespace: opts.namespace }],
  };
  const file = save(config);
  out.line(`Wrote ${file}`);
  const result: InitResult = { command: "init", file, config };
  out.result(result);
  return result;
}

export function registerInit(program: Command, deps: CliDeps): void {
  program
    .command("init")
    .description(`Create ${CONFIG_FILE} in the current directory.`)
    .requiredOption("--project <id>", "Project id (proj_...)")
    .option("--format <format>", "File format id", "json-nested")
    .option("--path <pattern>", "Path pattern with {locale}", "locales/{locale}.json")
    .option("--namespace <ns>", "Namespace", "default")
    .action((opts: InitOpts) => {
      runInit(opts, deps.out);
    });
}
