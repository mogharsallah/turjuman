import { z } from "zod";
import type { ScorePrompt } from "@turjuman/core";
import type { OpContext } from "@turjuman/sdk";

/**
 * Server-provided MCP Prompts — the *methodology* surface of AI scoring.
 *
 * Turjuman is BYO-LLM, so it can't grade translations itself; instead it serves
 * the grading prompt (the MQM rubric + project guidance + glossary + the strings)
 * to whichever agent is connected, so every client scores consistently. The
 * rendering is the service's job (`service.scoring.buildScorePrompt`, the single
 * seam shared with the REST score-prompt endpoint); these defs only declare the
 * prompt's arguments and map them onto that call. Registering any prompt makes
 * the server advertise the `prompts` capability (it advertised `tools` only before).
 *
 * Prompt arguments are strings on the wire (the MCP Prompts contract), so the
 * numeric `limit` arrives as a string and is parsed here.
 */
export interface PromptDef {
  name: string;
  description: string;
  argsSchema: Record<string, z.ZodTypeAny>;
  handler: (args: Record<string, string | undefined>, ctx: OpContext) => Promise<ScorePrompt>;
}

/** Parse a string prompt arg to a positive integer page size, or `undefined`. */
function parsePromptLimit(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export const PROMPTS: PromptDef[] = [
  {
    name: "score_translation",
    description:
      "Assemble an MQM 0–100 scoring prompt for ONE translation: the rubric, project guidance, glossary, source and target. Grade it, then submit the result with the score_translation tool.",
    argsSchema: {
      projectId: z.string().describe("Project id, e.g. proj_xxx"),
      locale: z.string().describe('Target locale code, e.g. "fr"'),
      name: z.string().describe("Key name to score"),
      namespace: z.string().optional().describe('Key namespace (defaults to "default")'),
    },
    handler: (a, { service, actor }) =>
      service.scoring.buildScorePrompt(actor, a.projectId!, a.locale!, {
        name: a.name!,
        namespace: a.namespace,
      }),
  },
  {
    name: "review_locale",
    description:
      "Assemble an MQM scoring prompt for a PAGE of a locale's translations at once. Grade them all, then submit with the review_translations tool. Page with limit + cursor.",
    argsSchema: {
      projectId: z.string().describe("Project id, e.g. proj_xxx"),
      locale: z.string().describe('Target locale code, e.g. "fr"'),
      limit: z.string().optional().describe("Page size (default 100, max 200)"),
      cursor: z.string().optional().describe("nextCursor from a previous page"),
    },
    handler: (a, { service, actor }) =>
      service.scoring.buildScorePrompt(actor, a.projectId!, a.locale!, {
        // Prompt args are strings; parse `limit` to a positive integer or omit it
        // (a non-numeric value must not reach DynamoDB's Limit as NaN).
        limit: parsePromptLimit(a.limit),
        cursor: a.cursor,
      }),
  },
];
