import type { qa } from "@turjuman/schema";
import type { OutputSink } from "./output.js";

/** Render a QA report as human lines. The machine result is emitted by the
 * caller (so push can nest it under its own document). */
export function printReport(report: qa.QaReport, out: OutputSink): void {
	for (const f of report.findings) {
		out.line(
			`${f.localeCode}  ${f.severity.padEnd(7)}  ${f.namespace}:${f.keyName}  ${f.checkId}  ${f.message}`,
		);
	}
	const { error, warning, info } = report.counts;
	out.line(`QA: ${error} error(s), ${warning} warning(s), ${info} info`);
}

/** The CLI-facing (flat) projection of a QA report for `--json`. */
export function reportPayload(report: qa.QaReport): {
	counts: qa.QaReport["counts"];
	findings: qa.QaReport["findings"];
} {
	return { counts: report.counts, findings: report.findings };
}
