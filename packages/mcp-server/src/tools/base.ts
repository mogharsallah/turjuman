import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  type Actor,
  TurjumanService,
  type User,
  apiKeyCreatedSchema,
  bulkSetResultSchema,
  emailSchema,
  globalRoleSchema,
  glossaryTermSchema,
  keyPageSchema,
  keyWithTranslationsSchema,
  localeCodeSchema,
  localeSchema,
  membershipSchema,
  namespaceSchema,
  projectRoleSchema,
  projectSchema,
  qaConfigSchema,
  qaReportSchema,
  qaSeveritySchema,
  settableStatusSchema,
  translationKeySchema,
  translationSchema,
  translationStatusSchema,
  userSchema,
  webhookSchema,
} from "@turjuman/core";

/** Re-exported so each tool group imports everything it needs from "./base.js".
 * Output schemas come straight from core (the canonical entity/wire schemas), so
 * the MCP `structuredContent` shapes can't drift from what the services return.
 * Enum/field schemas (roles, status, severity, locale/namespace) are likewise
 * re-exported from core rather than redefined, so a tool's input validation
 * can't drift from the entity definitions either. */
export {
  z,
  apiKeyCreatedSchema,
  bulkSetResultSchema,
  emailSchema,
  glossaryTermSchema,
  keyPageSchema,
  keyWithTranslationsSchema,
  localeCodeSchema,
  localeSchema,
  membershipSchema,
  namespaceSchema,
  projectSchema,
  qaConfigSchema,
  qaReportSchema,
  qaSeveritySchema,
  settableStatusSchema,
  translationKeySchema,
  translationSchema,
  translationStatusSchema,
  userSchema,
  webhookSchema,
  // The role field helpers used by admin tools are core's canonical enums.
  projectRoleSchema as projectRole,
  globalRoleSchema as globalRole,
};
export type { ToolAnnotations };

/** Everything a tool handler needs: the service and the authenticated caller. */
export interface ToolContext {
  service: TurjumanService;
  actor: Actor;
  user: User;
  /** Per-request correlation id, surfaced to the client on a masked error. */
  requestId: string;
}

/**
 * Tool-naming verb convention — keep names disambiguated so a model selecting
 * between near-synonyms picks the right tool (tool names are a public contract;
 * sharpen descriptions rather than renaming):
 *   create — make a new top-level entity (create_project, create_key)
 *   add    — attach a child to an existing parent (add_locale, add_member)
 *   set    — write a value, creating or replacing it (set_translation)
 *   update — patch an entity's metadata fields (update_key, update_project)
 *   delete — hard, cascading removal (delete_key, delete_project)
 *   remove — detach a child / mute, without deleting the parent (remove_member)
 */

/** Storage shape: the handler arg type is erased so tools of different schemas
 * can live in one array. {@link tool} preserves authoring-time type safety. */
export interface ToolDef {
  name: string;
  description: string;
  input: z.ZodTypeAny;
  /** Optional object schema for the tool's structured result (MCP `outputSchema`).
   * When present the SDK validates the emitted `structuredContent` against it. */
  output?: z.ZodTypeAny;
  /** Behaviour hints (readOnly/destructive/idempotent). When omitted, {@link
   * annotationsFor} derives them from the tool name. */
  annotations?: ToolAnnotations;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (args: any, ctx: ToolContext) => Promise<unknown>;
}

export function tool<S extends z.ZodTypeAny>(def: {
  name: string;
  description: string;
  input: S;
  output?: z.ZodTypeAny;
  annotations?: ToolAnnotations;
  handler: (args: z.infer<S>, ctx: ToolContext) => Promise<unknown>;
}): ToolDef {
  return def as ToolDef;
}

// ---- shared field schemas used across tool groups ---------------------------
// `projectRole`/`globalRole` are re-exported from core above (its canonical
// `projectRoleSchema`/`globalRoleSchema`) — not redefined here.

export const projectId = z.string().describe("Project id, e.g. proj_xxx");
// Reuse the shared field schemas (./validation in core) so the MCP boundary
// validates locale/namespace/email exactly as the service does.
export const namespace = namespaceSchema
  .optional()
  .describe('Key namespace (logical group). Defaults to "default".');
export const localeCode = localeCodeSchema.describe('Locale code, e.g. "fr" or "es-MX"');

// Output schemas for `structuredContent` are the canonical core schemas
// (`translationKeySchema`, `translationSchema`, `keyWithTranslationsSchema`,
// `bulkSetResultSchema`), re-exported above — no hand-maintained mirror here.
