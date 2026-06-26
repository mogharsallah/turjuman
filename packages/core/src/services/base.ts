import type { GlobalRole, Project, ProjectRole, User } from "@turjuman/schema";
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
}
