import type { Command } from "commander";
import type { CliDeps } from "../deps.js";

export function registerLocales(program: Command, deps: CliDeps): void {
	program
		.command("locales")
		.description("List the locales configured on the project.")
		.action(async () => {
			const config = deps.loadConfig();
			const { locales } = await deps
				.clientFactory()
				.listLocales(config.projectId);
			for (const l of locales) deps.out.line(`${l.code}\t${l.name ?? ""}`);
			deps.out.result({ command: "locales", locales });
		});
}
