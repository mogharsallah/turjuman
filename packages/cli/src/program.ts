import { Command } from "commander";
import { registerBootstrap } from "./commands/bootstrap.js";
import { registerCheck } from "./commands/check.js";
import { registerFormats } from "./commands/formats.js";
import { registerInit } from "./commands/init.js";
import { registerLocales } from "./commands/locales.js";
import { registerLogin } from "./commands/login.js";
import { registerProjects } from "./commands/projects.js";
import { registerPull } from "./commands/pull.js";
import { registerPush } from "./commands/push.js";
import { type CliDeps, defaultClientFactory, realLoadConfig } from "./deps.js";
import { createSink, wantsJson } from "./output.js";
import { cliVersion } from "./version.js";

/** Self-hosting (deploy/inspect/teardown) is no longer a CLI: it's the
 * `@turjuman/aws-cdk` construct deployed with `cdk deploy`. Catch the old verbs so
 * muscle-memory `turjuman deploy` gets a useful pointer instead of a bare
 * "unknown command". (`bootstrap` IS a real command now — handled above.) */
const DEPLOY_VERBS = new Set(["deploy", "status", "teardown"]);

function registerDeployHint(program: Command): void {
	program.on("command:*", (operands: string[]) => {
		const cmd = operands[0];
		if (cmd && DEPLOY_VERBS.has(cmd)) {
			process.stderr.write(
				`"${cmd}" is no longer a CLI command. Self-host Turjuman with the ` +
					"@turjuman/aws-cdk construct (deploy with `cdk deploy`), then run " +
					'"turjuman bootstrap" to create the first owner. See the self-hosting guide.\n',
			);
		} else {
			process.stderr.write(
				`Unknown command "${cmd ?? ""}". Run "turjuman --help".\n`,
			);
		}
		process.exitCode = 2;
	});
}

/** Build the commander program with injectable dependencies (tests pass fakes). */
export function buildProgram(deps: CliDeps): Command {
	const program = new Command();
	program
		.name("turjuman")
		.description(
			"Turjuman developer CLI — deterministic translation file sync for repos and CI.",
		)
		.version(cliVersion())
		.option(
			"--json",
			"Emit a machine-readable JSON result on stdout (for CI and agents).",
		);

	registerLogin(program, deps);
	registerBootstrap(program, deps);
	registerInit(program, deps);
	registerProjects(program, deps);
	registerLocales(program, deps);
	registerFormats(program, deps);
	registerPull(
		program,
		deps,
		"pull",
		"Download translations and write locale files.",
	);
	registerPull(
		program,
		deps,
		"build",
		"Build locale files from stored translations (alias of pull).",
	);
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
