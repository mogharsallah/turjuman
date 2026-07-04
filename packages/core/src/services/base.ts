import type {
	GlobalRole,
	Project,
	ProjectRole,
	Translation,
	User,
} from "@turjuman/schema";
import {
	type Actor,
	newId,
	notFound,
	type ProjectAction,
	requireEmail,
	requireProject,
	requireText,
} from "@turjuman/schema";
import type { RepositoryApi } from "../repository/index.js";

/**
 * Shared base for the domain sub-services. Holds the repository handle and the
 * per-method authorization preamble plus a few cross-domain helpers, so every
 * sub-service enforces RBAC and provisions users the same way. Field-format
 * validation lives in ../validation.ts, shared with the transports.
 */
export abstract class BaseService {
	constructor(protected readonly repo: RepositoryApi) {}

	/**
	 * Load a project (scoped to the actor's org) and enforce a project-scoped
	 * permission in one step — the single home of the per-method authorization
	 * preamble. The project read and the membership-role read run in parallel;
	 * OWNER/ADMIN short-circuit the role read entirely. NOT_FOUND (a missing or
	 * cross-org project) is thrown before FORBIDDEN, matching the prior order.
	 */
	protected async authorizeProject(
		actor: Actor,
		projectId: string,
		action: ProjectAction,
	): Promise<{ project: Project; role: ProjectRole | undefined }> {
		const [project, role] = await Promise.all([
			this.repo.getProject(projectId),
			this.projectRole(actor, projectId),
		]);
		if (!project || project.orgId !== actor.orgId)
			throw notFound("Project not found");
		requireProject(actor, action, role);
		return { project, role };
	}

	/** Effective project role, short-circuiting the DB read for OWNER/ADMIN. */
	protected async projectRole(
		actor: Actor,
		projectId: string,
	): Promise<ProjectRole | undefined> {
		if (actor.globalRole === "OWNER" || actor.globalRole === "ADMIN")
			return "MANAGER";
		return (await this.repo.getMembership(projectId, actor.userId))?.role;
	}

	protected async requireLocaleExists(
		projectId: string,
		code: string,
	): Promise<void> {
		if (!(await this.repo.getLocale(projectId, code))) {
			throw notFound(`Locale ${code} does not exist on this project`);
		}
	}

	protected async findUser(ref: {
		userId?: string;
		email?: string;
	}): Promise<User | undefined> {
		return ref.userId
			? this.repo.getUser(ref.userId)
			: ref.email
				? this.repo.getUserByEmail(ref.email)
				: undefined;
	}

	/** Shared user-creation used by createUser and member auto-provisioning. */
	protected async provisionUser(
		orgId: string,
		input: { email: string; name: string; globalRole?: GlobalRole },
	): Promise<User> {
		const email = requireEmail(input.email);
		const now = new Date().toISOString();
		const user: User = {
			id: newId("user"),
			orgId,
			email,
			name: requireText(input.name, "name"),
			globalRole: input.globalRole ?? "MEMBER",
			createdAt: now,
			updatedAt: now,
		};
		return this.repo.createUser(user);
	}

	/**
	 * Write a base-locale (source) value as an accept-append: append a version and
	 * advance the cell's `head`, exactly like an accept, so the source carries a
	 * consistent head→version chain a release can pin — a plain overwrite would drop
	 * the head and orphan the version chain (a later accept then recomputes `seq=1`
	 * into an existing `VER#` row). Idempotent: re-writing the same value appends
	 * nothing. On a child branch the cell is materialized first so the append lands
	 * on a branch-owned row; a brand-new cell is seeded so the first accept has a row
	 * to advance. Callers bump the key's `sourceRevision` separately.
	 */
	protected async writeSourceValue(params: {
		projectId: string;
		branchId: string;
		keyId: string;
		locale: string;
		value: string;
		origin?: Translation["origin"];
		userId: string;
	}): Promise<Translation> {
		const { projectId, branchId, keyId, locale, value, origin, userId } =
			params;
		const resolved = await this.repo.getCellResolved(
			projectId,
			branchId,
			keyId,
			locale,
		);
		// Already at this value with a version — no new version, and no needless
		// copy-on-write onto a child branch.
		if (
			resolved &&
			resolved.value.head !== undefined &&
			resolved.value.value === value
		)
			return resolved.value;
		const existing = await this.repo.materializeCell(
			projectId,
			branchId,
			keyId,
			locale,
		);
		if (!existing)
			// Seed the row so the first accept-append (expectedHead undefined) has a
			// cell to advance — acceptCell upserts a version, not a cell.
			await this.repo.putCell({
				projectId,
				branchId,
				keyId,
				locale,
				value,
				lifecycle: "accepted",
				stale: false,
				origin,
				updatedBy: userId,
				updatedAt: new Date().toISOString(),
			});
		return this.repo.acceptCell({
			projectId,
			branchId,
			keyId,
			locale,
			value,
			origin,
			acceptedBy: userId,
			expectedHead: existing?.head,
			updatedBy: userId,
		});
	}

	/**
	 * The cell's accepted (head) value: `cell.value` when the cell is itself
	 * `accepted`, else the head version's value (a cell re-drafted after accept still
	 * has an accepted head), else `undefined` (never accepted). Resolves the version
	 * through the branch's parent chain, so an inherited head reads on a child branch
	 * too. Shared by the export bundle and the QA accepted slot.
	 */
	protected async acceptedValue(
		projectId: string,
		branchId: string,
		cell: Pick<
			Translation,
			"head" | "lifecycle" | "value" | "keyId" | "locale"
		>,
	): Promise<string | undefined> {
		if (cell.head === undefined) return undefined;
		if (cell.lifecycle === "accepted") return cell.value;
		return (
			await this.repo.getVersionResolved(
				projectId,
				branchId,
				cell.keyId,
				cell.locale,
				cell.head,
			)
		)?.value;
	}
}
