import type { qa } from "@turjuman/schema";
import type { Command } from "commander";
import type { ApiClient } from "../client.js";
import type { ProjectConfig } from "../config.js";
import type { CliDeps } from "../deps.js";
import type { OutputSink } from "../output.js";
import { printReport, reportPayload } from "../report.js";

export interface CheckOpts {
	locale?: string;
	checks?: string[];
}

/** Run advisory QA checks and render the report. Returns the report so the
 * caller can decide the exit code (exit 1 when there are error findings). */
export async function runCheck(
	api: ApiClient,
	config: ProjectConfig,
	opts: CheckOpts,
	out: OutputSink,
): Promise<qa.QaReport> {
	const report = await api.runChecks(config.projectId, {
		locale: opts.locale,
		checks: opts.checks,
	});
	printReport(report, out);
	out.result({ command: "check", ...reportPayload(report) });
	return report;
}

export function registerCheck(program: Command, deps: CliDeps): void {
	program
		.command("check")
		.description(
			"Run advisory QA checks on the project's translations (exit non-zero on errors).",
		)
		.option(
			"--locale <code>",
			"Limit to one locale; omit to check all non-base locales",
		)
		.option(
			"--check <id...>",
			"Limit to specific check ids; omit to run all enabled checks",
		)
		.action(async (opts: { locale?: string; check?: string[] }) => {
			const config = deps.loadConfig();
			const report = await runCheck(
				deps.clientFactory(),
				config,
				{ locale: opts.locale, checks: opts.check },
				deps.out,
			);
			if (report.counts.error > 0) process.exitCode = 1;
		});
}
