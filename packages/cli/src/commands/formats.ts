import type { Command } from "commander";
import * as formats from "@turjuman/formats";
import type { CliDeps } from "../deps.js";

export function registerFormats(program: Command, deps: CliDeps): void {
  program
    .command("formats")
    .description("List supported file formats.")
    .action(() => {
      const list = formats.listFormats();
      for (const f of list) deps.out.line(`${f.id}\t(${f.extensions.join(", ")})\t${f.label}`);
      deps.out.result({ command: "formats", formats: list });
    });
}
