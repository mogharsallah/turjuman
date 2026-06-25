import { type Actor, type OrgAction, canOnOrg } from "@turjuman/core";
import {
  OPERATIONS,
  OPERATIONS_BY_NAME,
  OPERATION_GROUPS,
  type Operation,
  isReadOnly,
} from "@turjuman/sdk";

/**
 * Client-requested URL tool-scoping. An MCP client can narrow the advertised
 * toolset at connect time via query params on the connection URL:
 *
 *   ?tools=list_untranslated,bulk_set_translations   explicit allowlist
 *   ?groups=keys,translations                        whole domains
 *   ?groups=read                                     all read-only tools
 *
 * `tools` and `groups` union. This is a presentation filter that shrinks
 * `tools/list` (less context, less near-synonym ambiguity) — it is NOT a
 * security boundary; core RBAC still authorizes every call. Neither param ⇒ no
 * filter (all tools, unchanged). An unknown tool/group fails loud with a 400 so
 * a typo can never silently hide tools.
 */

/** Synthetic group: every tool advertised as read-only. Computed from the same
 * `isReadOnly` classification the SDK advertises, so it can't drift from the
 * hints the MCP server publishes. */
const READ_GROUP = "read";

/**
 * Tools gated by an org-level action the actor's GLOBAL role may lack — and that
 * no project membership can grant — so they are safe to hide when the role can't
 * perform them. Deliberately excluded: project-gated tools (member management:
 * a global MEMBER can be a project MANAGER) and self-service tools (the api-key
 * tools: a user always manages their own keys), since hiding those would break
 * legitimate use. `set_user_role`/`create_user` both floor at `user.manage`.
 */
const ORG_GATED_TOOLS: Record<string, OrgAction> = {
  create_project: "project.create",
  create_user: "user.manage",
  set_user_role: "user.manage",
};

/**
 * The tools an actor can actually reach, derived from the key's GLOBAL signals
 * only: a read-only key sees just read tools (every other tool needs a
 * non-`.read` action), and an org-gated tool shows only if the global role
 * permits its org action. Project-scoped permissions are deliberately NOT
 * applied — they vary per project and are unknown at list time — so this never
 * hides a tool the key might legitimately use on some project. Mirrors the
 * authorization core still enforces on every call; it only trims what is shown.
 */
export function allowedToolsForActor(actor: Actor): Set<string> {
  const allowed = new Set<string>();
  for (const def of OPERATIONS) {
    if (actor.readOnly === true && !isReadOnly(def)) continue;
    const orgAction = ORG_GATED_TOOLS[def.name];
    if (orgAction && !canOnOrg(actor, orgAction)) continue;
    allowed.add(def.name);
  }
  return allowed;
}

export type ToolScope = { allowed: Set<string> } | { error: string };

function splitCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** The tools in a named group, or `undefined` if the group name is unknown. */
function toolsInGroup(group: string): Operation[] | undefined {
  if (group === READ_GROUP) return OPERATIONS.filter((t) => isReadOnly(t));
  return OPERATION_GROUPS[group];
}

function validGroupNames(): string[] {
  return [...Object.keys(OPERATION_GROUPS), READ_GROUP];
}

/**
 * Resolve the requested tool scope from the URL query.
 * - `undefined` — no `tools`/`groups` given (or only empty values): no filter.
 * - `{ allowed }` — the union of the requested tools and groups.
 * - `{ error }`  — an unknown tool or group name (caller should answer 400).
 */
export function resolveToolScope(
  query: Record<string, string | undefined> | undefined,
): ToolScope | undefined {
  if (!query) return undefined;
  const requestedTools = splitCsv(query.tools);
  const requestedGroups = splitCsv(query.groups);
  if (requestedTools.length === 0 && requestedGroups.length === 0) return undefined;

  const unknownTools = requestedTools.filter((name) => !OPERATIONS_BY_NAME.has(name));
  if (unknownTools.length > 0) {
    return { error: `Unknown tool(s): ${unknownTools.join(", ")}.` };
  }
  const unknownGroups = requestedGroups.filter((g) => toolsInGroup(g) === undefined);
  if (unknownGroups.length > 0) {
    return {
      error: `Unknown group(s): ${unknownGroups.join(", ")}. Valid groups: ${validGroupNames().join(", ")}.`,
    };
  }

  const allowed = new Set<string>(requestedTools);
  for (const g of requestedGroups) {
    for (const t of toolsInGroup(g) ?? []) allowed.add(t.name);
  }
  return { allowed };
}
