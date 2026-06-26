import { describe, expect, it } from "vitest";
import type { GlobalRole, ProjectRole } from "./domain.js";
import {
	type Actor,
	canOnOrg,
	canOnProject,
	effectiveProjectRole,
	type OrgAction,
	type ProjectAction,
} from "./rbac.js";

/**
 * Layer 1 — the RBAC matrix as a pure decision table (TESTING.md).
 *
 * The maps under test (`PROJECT_ROLE_ACTIONS`/`ORG_ROLE_ACTIONS`) are module-
 * private, so the only way to assert them is through the pure `canOn*` checks —
 * and we assert against a SECOND, hand-authored truth table written here from the
 * policy spec, never re-derived from the implementation. The loop is exhaustive:
 * every (role × action) cell, both the `true` and the `false` ones, so a single
 * action moved between roles fails a named cell. (Per the independent-oracle rule:
 * a table copied from the source would assert `X === X`.)
 */

// The full action vocabularies, hand-enumerated (TypeScript erases the unions at
// runtime, so these lists are the test's own source of truth).
const ALL_PROJECT_ACTIONS: ProjectAction[] = [
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
];

const ALL_ORG_ACTIONS: OrgAction[] = [
	"project.create",
	"user.read",
	"user.manage",
	"apikey.manage",
	"role.admin",
];

// ── Independent truth table — hand-authored from the RBAC spec, NOT the maps ──
const PROJECT_TRUTH: Record<ProjectRole, ProjectAction[]> = {
	MANAGER: [...ALL_PROJECT_ACTIONS], // MANAGER may do everything on its project
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
};

const ORG_TRUTH: Record<GlobalRole, OrgAction[]> = {
	OWNER: [
		"project.create",
		"user.read",
		"user.manage",
		"apikey.manage",
		"role.admin",
	],
	ADMIN: ["project.create", "user.read", "user.manage", "apikey.manage"],
	MEMBER: ["user.read"],
};

const PROJECT_ROLES: ProjectRole[] = [
	"MANAGER",
	"EDITOR",
	"DEVELOPER",
	"VIEWER",
];
const GLOBAL_ROLES: GlobalRole[] = ["OWNER", "ADMIN", "MEMBER"];

/** A plain MEMBER actor — their project authority is exactly their membership. */
function memberActor(over: Partial<Actor> = {}): Actor {
	return { userId: "u-member", orgId: "o1", globalRole: "MEMBER", ...over };
}

describe("effectiveProjectRole", () => {
	it("elevates OWNER/ADMIN to MANAGER on any project, ignoring membership", () => {
		expect(effectiveProjectRole("OWNER", undefined)).toBe("MANAGER");
		expect(effectiveProjectRole("OWNER", "VIEWER")).toBe("MANAGER");
		expect(effectiveProjectRole("ADMIN", undefined)).toBe("MANAGER");
		expect(effectiveProjectRole("ADMIN", "VIEWER")).toBe("MANAGER");
	});

	it("uses the explicit membership role for a MEMBER (none ⇒ undefined)", () => {
		expect(effectiveProjectRole("MEMBER", "EDITOR")).toBe("EDITOR");
		expect(effectiveProjectRole("MEMBER", "VIEWER")).toBe("VIEWER");
		expect(effectiveProjectRole("MEMBER", undefined)).toBeUndefined();
	});
});

describe("canOnProject — exhaustive (membership role × action)", () => {
	describe.each(PROJECT_ROLES)("membership %s", (role) => {
		const allowed = new Set(PROJECT_TRUTH[role]);
		it.each(ALL_PROJECT_ACTIONS)(`%s`, (action) => {
			expect(canOnProject(memberActor(), action, role)).toBe(
				allowed.has(action),
			);
		});
	});

	it("a MEMBER with no membership is denied every action", () => {
		for (const action of ALL_PROJECT_ACTIONS) {
			expect(canOnProject(memberActor(), action, undefined)).toBe(false);
		}
	});
});

describe("canOnProject — OWNER/ADMIN are MANAGER everywhere (elevation overrides membership)", () => {
	describe.each<GlobalRole>(["OWNER", "ADMIN"])("%s actor", (globalRole) => {
		const managerSet = new Set(PROJECT_TRUTH.MANAGER);
		// Even with a deliberately weak VIEWER membership, authority is MANAGER's.
		it.each(ALL_PROJECT_ACTIONS)(`%s (with VIEWER membership)`, (action) => {
			expect(canOnProject(memberActor({ globalRole }), action, "VIEWER")).toBe(
				managerSet.has(action),
			);
		});
		it.each(ALL_PROJECT_ACTIONS)(`%s (with no membership)`, (action) => {
			expect(canOnProject(memberActor({ globalRole }), action, undefined)).toBe(
				managerSet.has(action),
			);
		});
	});
});

describe("canOnProject — a read-only key permits only *.read, even for a MANAGER", () => {
	it.each(ALL_PROJECT_ACTIONS)(`%s`, (action) => {
		const ro = memberActor({ readOnly: true });
		// MANAGER allows everything, so the read-only mask is the only thing left.
		expect(canOnProject(ro, action, "MANAGER")).toBe(action.endsWith(".read"));
	});
});

describe("canOnOrg — exhaustive (global role × action)", () => {
	describe.each(GLOBAL_ROLES)("global %s", (globalRole) => {
		const allowed = new Set(ORG_TRUTH[globalRole]);
		it.each(ALL_ORG_ACTIONS)(`%s`, (action) => {
			expect(canOnOrg(memberActor({ globalRole }), action)).toBe(
				allowed.has(action),
			);
		});
	});

	it("only OWNER may grant privileged roles (role.admin)", () => {
		// Pinned bespoke — the single cell distinguishing OWNER from ADMIN.
		expect(canOnOrg(memberActor({ globalRole: "OWNER" }), "role.admin")).toBe(
			true,
		);
		expect(canOnOrg(memberActor({ globalRole: "ADMIN" }), "role.admin")).toBe(
			false,
		);
	});
});

describe("canOnOrg — a read-only key permits only *.read, even for an OWNER", () => {
	it.each(ALL_ORG_ACTIONS)(`%s`, (action) => {
		const ro = memberActor({ globalRole: "OWNER", readOnly: true });
		expect(canOnOrg(ro, action)).toBe(action.endsWith(".read"));
	});
});
