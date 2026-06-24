import type { ToolDef } from "./base.js";
import { adminTools } from "./admin.js";
import { glossaryTools } from "./glossary.js";
import { keyTools } from "./keys.js";
import { lifecycleTools } from "./lifecycle.js";
import { projectTools } from "./projects.js";
import { qaTools } from "./qa.js";
import { scoringTools } from "./scoring.js";
import { translationTools } from "./translations.js";

export type { ToolContext, ToolDef } from "./base.js";

/** Every MCP tool, grouped by domain in ./tools/*. */
export const TOOLS: ToolDef[] = [
  ...projectTools,
  ...keyTools,
  ...translationTools,
  ...glossaryTools,
  ...lifecycleTools,
  ...qaTools,
  ...scoringTools,
  ...adminTools,
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// `lifecycleTools` mixes webhooks with the destructive project lifecycle; the
// caller-facing groups split them so `webhooks` and `projects` read intuitively.
const deleteProjectTools = lifecycleTools.filter((t) => t.name === "delete_project");
const webhookTools = lifecycleTools.filter((t) => t.name !== "delete_project");

/** Caller-facing tool groups for URL tool-scoping (`?groups=`). Defined here as
 * the single source of group membership, decoupled from the source-file arrays
 * (so `delete_project` reads under `projects`, not a "lifecycle" group). The
 * synthetic `read` group is computed at scope-resolution time from each tool's
 * advertised `readOnlyHint`, so it is not listed here. */
export const TOOL_GROUPS: Record<string, ToolDef[]> = {
  projects: [...projectTools, ...deleteProjectTools],
  keys: keyTools,
  translations: translationTools,
  glossary: glossaryTools,
  webhooks: webhookTools,
  qa: qaTools,
  scoring: scoringTools,
  admin: adminTools,
};
