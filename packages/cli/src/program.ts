import { Command } from "commander";
import { type CliDeps, defaultClientFactory, realLoadConfig } from "./deps.js";
import { createSink, wantsJson } from "./output.js";
import { cliVersion } from "./version.js";
import { registerLogin } from "./commands/login.js";
import { registerInit } from "./commands/init.js";
import { registerFormats } from "./commands/formats.js";
import { registerProjects } from "./commands/projects.js";
import { registerLocales } from "./commands/locales.js";
import { registerPull } from "./commands/pull.js";
import { registerPush } from "./commands/push.js";
import { registerCheck } from "./commands/check.js";

/** The self-host/deploy verbs moved to the separate `@turjuman/aws-deploy` tool
 * so the sync CLI install stays free of the AWS SDK + CDK. Point users there. */
const DEPLOY_VERBS = new Set(["deploy", "status", "teardown", "bootstrap"]);

function registerDeployHint(program: Command): void {
  program.on("command:*", (operands: string[]) => {
    const cmd = operands[0];
    if (cmd && DEPLOY_VERBS.has(cmd)) {
      process.stderr.write(
        `"${cmd}" is part of the Turjuman self-host tooling. Run it with:\n` +
          `  npx @turjuman/aws-deploy ${cmd}\n`,
      );
    } else {
      process.stderr.write(`Unknown command "${cmd ?? ""}". Run "turjuman --help".\n`);
    }
    process.exitCode = 2;
  });
}

/** Build the commander program with injectable dependencies (tests pass fakes). */
export function buildProgram(deps: CliDeps): Command {
  const program = new Command();
  program
    .name("turjuman")
    .description("Turjuman developer CLI — deterministic translation file sync for repos and CI.")
    .version(cliVersion())
    .option("--json", "Emit a machine-readable JSON result on stdout (for CI and agents).");

  registerLogin(program, deps);
  registerInit(program, deps);
  registerProjects(program, deps);
  registerLocales(program, deps);
  registerFormats(program, deps);
  registerPull(program, deps, "pull", "Download translations and write locale files.");
  registerPull(program, deps, "build", "Build locale files from stored translations (alias of pull).");
  registerPush(program, deps);
  registerCheck(program, deps);
  registerDeployHint(program);

  return program;
}

/** Build the program with real dependencies and the sink chosen from argv. */
export function buildDefaultProgram(argv: readonly string[] = process.argv): {
  program: Command;
  flush: () => void;
} {
  const out = createSink(wantsJson(argv));
  const program = buildProgram({
    out,
    clientFactory: defaultClientFactory,
    loadConfig: realLoadConfig,
  });
  return { program, flush: () => out.flush() };
}
