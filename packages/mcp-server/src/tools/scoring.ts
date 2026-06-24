import {
  type ToolDef,
  localeCode,
  localeKeyList,
  namespace,
  pageCursor,
  pageLimit,
  projectId,
  reviewResultSchema,
  scoreConfigSchema,
  scoreValueSchema,
  tool,
  translationSchema,
  z,
} from "./base.js";

/** An MQM quality score, 0–100 — the shared bound from core, with a tool-facing description. */
const scoreValue = scoreValueSchema.describe("MQM quality score, 0–100.");

/**
 * AI quality scoring + review. The grading runs in the connected agent — fetch
 * the `score_translation` (or `review_locale`) MCP prompt to grade against the
 * MQM rubric, then submit the number here. The server records provenance and
 * routes: below the project threshold → `needs_review`; at/above with
 * auto-approve on (and a review role, machine-origin value) → `approved`.
 */
export const scoringTools: ToolDef[] = [
  tool({
    name: "score_translation",
    description:
      "Submit an MQM quality score (0–100) and optional comment for one translation. Grade with the score_translation prompt first. Routing: below the project threshold → needs_review; at/above with auto-approve enabled (and a review role, machine-origin value) → approved; otherwise translated. A re-score overwrites the previous score.",
    input: z.object({
      projectId,
      locale: localeCode,
      name: z.string(),
      namespace,
      score: scoreValue,
      comment: z.string().optional().describe("One or two sentences citing the main MQM issues."),
      model: z.string().optional().describe("Identifier of the model that produced the score (provenance)."),
    }),
    output: translationSchema,
    handler: (a, { service, actor }) =>
      service.scoring.score(actor, a.projectId, a.locale, {
        name: a.name,
        namespace: a.namespace,
        score: a.score,
        comment: a.comment,
        model: a.model,
      }),
  }),
  tool({
    name: "review_translations",
    description:
      "Submit scores for many translations in one locale at once (after batch grading with the review_locale prompt). Routes each like score_translation. Returns counts of written/approved/flagged plus any skipped unknown keys.",
    input: z.object({
      projectId,
      locale: localeCode,
      entries: z
        .array(
          z.object({
            name: z.string(),
            namespace,
            score: scoreValue,
            comment: z.string().optional(),
            model: z.string().optional(),
          }),
        )
        .min(1)
        .max(500),
    }),
    output: reviewResultSchema,
    handler: (a, { service, actor }) =>
      service.scoring.reviewBatch(
        actor,
        a.projectId,
        a.locale,
        a.entries.map((e) => ({
          name: e.name,
          namespace: e.namespace,
          score: e.score,
          comment: e.comment,
          model: e.model,
        })),
      ),
  }),
  tool({
    name: "list_for_review",
    description:
      "List keys whose translation for a locale is flagged needs_review (scored below the project threshold). Work this queue: fix the value or approve it. Paged: returns up to `limit` keys (default 100, max 200) plus a `nextCursor`.",
    input: z.object({ projectId, locale: localeCode, limit: pageLimit, cursor: pageCursor }),
    output: localeKeyList,
    handler: async (a, { service, actor }) => {
      const page = await service.scoring.listForReviewPage(actor, a.projectId, a.locale, {
        limit: a.limit ?? 100,
        cursor: a.cursor,
      });
      return { locale: a.locale, count: page.keys.length, keys: page.keys, nextCursor: page.nextCursor };
    },
  }),
  tool({
    name: "get_score_config",
    description:
      "Get the project's AI-scoring config: the auto-approve `threshold` (0–100), the `autoApprove` opt-in, and any evaluation `guidance` merged into the scoring prompt.",
    input: z.object({ projectId }),
    output: scoreConfigSchema,
    handler: (a, { service, actor }) => service.scoring.getConfig(actor, a.projectId),
  }),
  tool({
    name: "set_score_config",
    description:
      "Set the project's AI-scoring config. `threshold` (0–100, default 90) is the auto-approve bar; `autoApprove` (default off) turns on auto-promotion of high-scored machine translations; `guidance` is merged into the scoring prompt. Requires a project-management role.",
    input: z.object({
      projectId,
      threshold: scoreValue.optional(),
      autoApprove: z.boolean().optional(),
      guidance: z.string().optional().describe("Per-project evaluation guidance, merged into the scoring prompt."),
    }),
    output: scoreConfigSchema,
    handler: ({ projectId: id, ...input }, { service, actor }) =>
      service.scoring.setConfig(actor, id, input),
  }),
];
