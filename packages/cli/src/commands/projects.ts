import type { Command } from "commander";
import type { CliDeps } from "../deps.js";

export function registerProjects(program: Command, deps: CliDeps): void {
  program
    .command("projects")
    .description("List projects you can access.")
    .action(async () => {
      const { projects } = await deps.clientFactory().listProjects();
      for (const p of projects) deps.out.line(`${p.id}\t${p.baseLocale}\t${p.name}`);
      if (projects.length === 0) deps.out.line("(no projects)");
      deps.out.result({ command: "projects", projects });
    });
}
