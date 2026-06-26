import type { GlobalRole, ProjectRole } from "./domain.js";
import { forbidden } from "./errors.js";

/**
 * RBAC — the first-class authorization layer.
 *
 * Authentication (resolving an API key to a user) is intentionally separate and
 * simple. ALL authority lives here: a small, auditable permission matrix that
 * every mutating service call runs through.
 */

/** Actions scoped to a single project; gated by the actor's effective project role. */
export type ProjectAction =
	| "project.read"
	| "project.update"
	| "project.delete"
	| "member.read"
	| "member.manage"
	| "locale.read"
	| "locale.manage"
	| "key.read"
	| "key.manage"
	| "translation.read"
	| "translation.write"
	| "translation.review"
	| "glossary.read"
	| "glossary.manage"
	| "webhook.manage";

/** Actions scoped to the organisation; gated by the actor's global role. */
export type OrgAction =
	| "project.create"
	| "user.read"
	| "user.manage"
	| "apikey.manage" // issue/revoke API keys for OTHER users
	| "role.admin"; // grant or change a privileged (OWNER/ADMIN) global role

/** The authenticated caller, as needed for authorization decisions. */
export interface Actor {
	userId: string;
	orgId: string;
	globalRole: GlobalRole;
	/**
	 * Set when the actor authenticated with a read-only API key. Such a key may
	 * only perform read actions (those named `*.read`), regardless of the user's
	 * role — a least-privilege credential for CI pulls and dashboards.
	 */
	readOnly?: boolean;
}

/** A read-only actor may perform only `*.read` actions. */
function deniedByReadOnly(actor: Actor, action: string): boolean {
	return actor.readOnly === true && !action.endsWith(".read");
}

const PROJECT_ROLE_ACTIONS = {
	MANAGER: [
		"project.read",
		"project.update",
		"project.delete",
		"member.read",
		"member.manage",
		"locale.read",
		"locale.manage",
		"key.read",
		"key.manage",
		"translation.read",
		"translation.write",
		"translation.review",
		"glossary.read",
		"glossary.manage",
		"webhook.manage",
	],
	EDITOR: [
		"project.read",
		"member.read",
		"locale.read",
		"key.read",
		"key.manage",
		"translation.read",
		"translation.write",
		"translation.review",
		"glossary.read",
		"glossary.manage",
	],
	DEVELOPER: [
		"project.read",
		"member.read",
		"locale.read",
		"locale.manage",
		"key.read",
		"key.manage",
		"translation.read",
		"translation.write",
		"glossary.read",
		"glossary.manage",
	],
	VIEWER: [
		"project.read",
		"member.read",
		"locale.read",
		"key.read",
		"translation.read",
		"glossary.read",
	],
} as const satisfies Record<ProjectRole, readonly ProjectAction[]>;

const ORG_ROLE_ACTIONS = {
	OWNER: [
		"project.create",
		"user.read",
		"user.manage",
		"apikey.manage",
		"role.admin",
	],
	ADMIN: ["project.create", "user.read", "user.manage", "apikey.manage"],
	MEMBER: ["user.read"],
} as const satisfies Record<GlobalRole, readonly OrgAction[]>;

/** O(1) lookup sets derived from the matrices above; the arrays stay the source of truth. */
const PROJECT_ROLE_ACTION_SET: Record<
	ProjectRole,
	ReadonlySet<ProjectAction>
> = {
	MANAGER: new Set(PROJECT_ROLE_ACTIONS.MANAGER),
	EDITOR: new Set(PROJECT_ROLE_ACTIONS.EDITOR),
	DEVELOPER: new Set(PROJECT_ROLE_ACTIONS.DEVELOPER),
	VIEWER: new Set(PROJECT_ROLE_ACTIONS.VIEWER),
};

const ORG_ROLE_ACTION_SET: Record<GlobalRole, ReadonlySet<OrgAction>> = {
	OWNER: new Set(ORG_ROLE_ACTIONS.OWNER),
	ADMIN: new Set(ORG_ROLE_ACTIONS.ADMIN),
	MEMBER: new Set(ORG_ROLE_ACTIONS.MEMBER),
};

/**
 * An OWNER/ADMIN acts as MANAGER on every project in their org. Otherwise the
 * actor's authority is exactly their explicit membership role (if any).
 */
export function effectiveProjectRole(
	globalRole: GlobalRole,
	membershipRole: ProjectRole | undefined,
): ProjectRole | undefined {
	if (globalRole === "OWNER" || globalRole === "ADMIN") return "MANAGER";
	return membershipRole;
}

/** Pure check: may `actor` perform `action` on a project, given their membership? */
export function canOnProject(
	actor: Actor,
	action: ProjectAction,
	membershipRole: ProjectRole | undefined,
): boolean {
	if (deniedByReadOnly(actor, action)) return false;
	const role = effectiveProjectRole(actor.globalRole, membershipRole);
	if (!role) return false;
	return PROJECT_ROLE_ACTION_SET[role].has(action);
}

/** Pure check: may `actor` perform an org-level `action`? */
export function canOnOrg(actor: Actor, action: OrgAction): boolean {
	if (deniedByReadOnly(actor, action)) return false;
	return ORG_ROLE_ACTION_SET[actor.globalRole].has(action);
}

/** Enforce a project-scoped permission, throwing FORBIDDEN when denied. */
export function requireProject(
	actor: Actor,
	action: ProjectAction,
	membershipRole: ProjectRole | undefined,
): void {
	if (!canOnProject(actor, action, membershipRole)) {
		throw forbidden(`Your role does not permit "${action}" on this project`);
	}
}

/** Enforce an org-scoped permission, throwing FORBIDDEN when denied. */
export function requireOrg(actor: Actor, action: OrgAction): void {
	if (!canOnOrg(actor, action)) {
		throw forbidden(`Your role does not permit "${action}"`);
	}
}
