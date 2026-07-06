import {
	branchInput,
	fieldReportSchema,
	localeCode,
	namespace,
	type Operation,
	op,
	projectId,
	z,
} from "../base.js";

/** Field reports: production feedback that a shipped string is wrong — the one
 * fact the in-loop agent can't know from its own context. Filing reopens the cell
 * for a fix; resolving compounds the correction into reusable context. */
export const fieldReportOps: Operation[] = [
	op({
		name: "file_field_report",
		description:
			"Report a shipped string as wrong. Reopens the targeted cell (`accepted → proposed`) so a run can fix it. `releaseRef` names the release that was live when the bad string shipped.",
		input: z.object({
			projectId,
			locale: localeCode,
			name: z.string(),
			namespace,
			branch: branchInput,
			releaseRef: z
				.string()
				.optional()
				.describe("Release that was live (provenance)."),
			description: z.string(),
		}),
		output: fieldReportSchema,
		handler: ({ projectId: id, ...input }, { service, actor }) =>
			service.fieldReports.file(actor, id, input),
	}),
	op({
		name: "list_field_reports",
		description: "List the project's field reports.",
		input: z.object({ projectId }),
		output: z.array(fieldReportSchema),
		annotations: { readOnlyHint: true },
		handler: (a, { service, actor }) =>
			service.fieldReports.list(actor, a.projectId),
	}),
	op({
		name: "resolve_field_report",
		description:
			"Resolve a field report: close it and optionally spawn a gold Example (base → the fixed value) or a glossary term, so the correction becomes reusable context.",
		input: z.object({
			projectId,
			reportId: z.string(),
			spawnExample: z.boolean().optional(),
			spawnGlossary: z
				.object({
					term: z.string(),
					translations: z.record(z.string()).optional(),
				})
				.optional(),
		}),
		output: fieldReportSchema,
		handler: ({ projectId: id, reportId, ...input }, { service, actor }) =>
			service.fieldReports.resolve(actor, id, reportId, input),
	}),
];
