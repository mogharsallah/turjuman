import {
  type Operation,
  localeCode,
  localeCodeSchema,
  namespaceSchema,
  op,
  projectId,
  qaConfigSchema,
  qaReportSchema,
  qaSeveritySchema,
  z,
} from "../base.js";

/** Automated QA checks and per-project QA configuration. */
export const qaOps: Operation[] = [
  op({
    name: "run_qa_checks",
    description:
      "Run deterministic QA checks on translations (ICU/placeholder/plural/markup/length/whitespace/punctuation/empty/glossary/duplicate/stale). Advisory — run this before approving, then fix any errors. Returns findings grouped by locale with error/warning/info counts. Prefer passing a single `locale`.",
    input: z.object({
      projectId,
      locale: localeCode.optional().describe("Limit to one locale; omit to check all non-base locales."),
      checks: z.array(z.string()).optional().describe("Limit to specific check ids; omit to run all enabled checks."),
      slot: z
        .enum(["working", "approved"])
        .optional()
        .describe('Which value to check: the working draft (default) or the "approved" snapshot.'),
    }),
    output: qaReportSchema,
    // Advisory only: computes findings, never mutates. The name doesn't match the
    // read-verb convention, so the hint is set explicitly.
    annotations: { readOnlyHint: true },
    handler: (a, { service, actor }) =>
      service.qa.run(actor, a.projectId, { locale: a.locale, checkIds: a.checks, slot: a.slot }),
  }),
  op({
    name: "get_qa_config",
    description: "Get the project's QA configuration (per-check enable/severity overrides and ignore rules).",
    input: z.object({ projectId }),
    output: qaConfigSchema,
    handler: (a, { service, actor }) => service.qa.getConfig(actor, a.projectId),
  }),
  op({
    name: "set_qa_config",
    description:
      "Set the project's QA configuration. `checks` maps a check id to { enabled, severity } overrides; `ignore` mutes findings matching all listed fields. Requires a project-management role.",
    input: z.object({
      projectId,
      checks: z
        .record(z.object({ enabled: z.boolean().optional(), severity: qaSeveritySchema.optional() }))
        .optional()
        .describe("check id -> { enabled, severity } override"),
      ignore: z
        .array(
          z.object({
            checkId: z.string().optional(),
            namespace: namespaceSchema.optional(),
            keyName: z.string().optional(),
            locale: localeCodeSchema.optional(),
          }),
        )
        .max(500)
        .optional()
        .describe("Mute rules; each must specify at least one field."),
    }),
    output: qaConfigSchema,
    handler: ({ projectId: id, ...input }, { service, actor }) => service.qa.setConfig(actor, id, input),
  }),
];
