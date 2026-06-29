import type { Operation } from "../base.js";
import { adminOps } from "./admin.js";
import { branchOps } from "./branches.js";
import { commentOps } from "./comments.js";
import { contextOps } from "./context.js";
import { escalationOps } from "./escalations.js";
import { exampleOps } from "./examples.js";
import { glossaryOps } from "./glossary.js";
import { keyOps } from "./keys.js";
import { lifecycleOps } from "./lifecycle.js";
import { namespaceOps } from "./namespaces.js";
import { projectOps } from "./projects.js";
import { qaOps } from "./qa.js";
import { runOps } from "./runs.js";
import { translationOps } from "./translations.js";

/** Every Turjuman operation, grouped by domain in ./operations/*. This is the
 * single source of capability: the MCP server projects it to tools, the REST API
 * projects it to routes, and the code-mode sandbox projects it to `turjuman.*`
 * stubs — none of them re-declare an operation. */
export const OPERATIONS: Operation[] = [
	...projectOps,
	...branchOps,
	...namespaceOps,
	...keyOps,
	...translationOps,
	...runOps,
	...contextOps,
	...exampleOps,
	...escalationOps,
	...commentOps,
	...glossaryOps,
	...lifecycleOps,
	...qaOps,
	...adminOps,
];

export const OPERATIONS_BY_NAME = new Map(OPERATIONS.map((o) => [o.name, o]));

// `lifecycleOps` mixes webhooks with the destructive project lifecycle; the
// caller-facing groups split them so `webhooks` and `projects` read intuitively.
const deleteProjectOps = lifecycleOps.filter(
	(o) => o.name === "delete_project",
);
const webhookOps = lifecycleOps.filter((o) => o.name !== "delete_project");

/** Caller-facing operation groups (domains). Defined here as the single source of
 * group membership, decoupled from the source-file arrays (so `delete_project`
 * reads under `projects`, not a "lifecycle" group). Used by MCP URL tool-scoping
 * (`?groups=`) and by the knowledge layer's `search` (orientation + grouping).
 * The synthetic `read` group is computed at
 * scope-resolution time from each operation's advertised read-only hint, so it is
 * not listed here. */
export const OPERATION_GROUPS: Record<string, Operation[]> = {
	projects: [...projectOps, ...deleteProjectOps],
	branches: branchOps,
	namespaces: namespaceOps,
	keys: keyOps,
	translations: translationOps,
	runs: runOps,
	context: contextOps,
	examples: exampleOps,
	escalations: escalationOps,
	comments: commentOps,
	glossary: glossaryOps,
	webhooks: webhookOps,
	qa: qaOps,
	admin: adminOps,
};

/** Reverse index: the group an operation belongs to (for the knowledge `search` / docs).
 * `delete_project` resolves to `projects`, matching {@link OPERATION_GROUPS}. */
export const GROUP_BY_OPERATION: Map<string, string> = new Map(
	Object.entries(OPERATION_GROUPS).flatMap(([group, ops]) =>
		ops.map((o) => [o.name, group] as const),
	),
);
