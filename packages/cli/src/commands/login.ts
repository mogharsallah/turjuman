import type { Command } from "commander";
import type { CliDeps } from "../deps.js";
import { saveAuth } from "../config.js";

export function registerLogin(program: Command, deps: CliDeps): void {
  program
    .command("login")
    .description("Save API URL and key for this machine.")
    .requiredOption("--url <url>", "Turjuman API base URL")
    .requiredOption("--key <key>", "API key (op_live_...)")
    .action((opts: { url: string; key: string }) => {
      const file = saveAuth({ url: opts.url, key: opts.key });
      deps.out.line(`Saved credentials to ${file}`);
      deps.out.result({ command: "login", file });
    });
}
