import type { Operation } from "../base.js";
import { adminOps } from "./admin.js";
import { glossaryOps } from "./glossary.js";
import { keyOps } from "./keys.js";
import { lifecycleOps } from "./lifecycle.js";
import { projectOps } from "./projects.js";
import { qaOps } from "./qa.js";
import { scoringOps } from "./scoring.js";
import { translationOps } from "./translations.js";

/** Every Turjuman operation, grouped by domain in ./operations/*. This is the
 * single source of capability: the MCP server projects it to tools, the REST API
 * projects it to routes, and the code-mode sandbox projects it to `turjuman.*`
 * stubs — none of them re-declare an operation. */
export const OPERATIONS: Operation[] = [
  ...projectOps,
  ...keyOps,
  ...translationOps,
  ...glossaryOps,
  ...lifecycleOps,
  ...qaOps,
  ...scoringOps,
  ...adminOps,
];

export const OPERATIONS_BY_NAME = new Map(OPERATIONS.map((o) => [o.name, o]));

// `lifecycleOps` mixes webhooks with the destructive project lifecycle; the
// caller-facing groups split them so `webhooks` and `projects` read intuitively.
const deleteProjectOps = lifecycleOps.filter((o) => o.name === "delete_project");
const webhookOps = lifecycleOps.filter((o) => o.name !== "delete_project");

/** Caller-facing operation groups (domains). Defined here as the single source of
 * group membership, decoupled from the source-file arrays (so `delete_project`
 * reads under `projects`, not a "lifecycle" group). Used by MCP URL tool-scoping
 * (`?groups=`) and by `search_sdk`. The synthetic `read` group is computed at
 * scope-resolution time from each operation's advertised read-only hint, so it is
 * not listed here. */
export const OPERATION_GROUPS: Record<string, Operation[]> = {
  projects: [...projectOps, ...deleteProjectOps],
  keys: keyOps,
  translations: translationOps,
  glossary: glossaryOps,
  webhooks: webhookOps,
  qa: qaOps,
  scoring: scoringOps,
  admin: adminOps,
};

/** Reverse index: the group an operation belongs to (for `search_sdk` / docs).
 * `delete_project` resolves to `projects`, matching {@link OPERATION_GROUPS}. */
export const GROUP_BY_OPERATION: Map<string, string> = new Map(
  Object.entries(OPERATION_GROUPS).flatMap(([group, ops]) => ops.map((o) => [o.name, group] as const)),
);
