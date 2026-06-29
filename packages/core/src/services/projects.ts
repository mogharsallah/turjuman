import type { Project } from "@turjuman/schema";
import {
	type Actor,
	newId,
	requireLocale,
	requireOrg,
	requireText,
	slugify,
	validation,
} from "@turjuman/schema";
import type { RepositoryApi } from "../repository/index.js";
import { BaseService } from "./base.js";
import type { BranchService } from "./branches.js";
import type { CreateProjectInput } from "./types.js";

export class ProjectsService extends BaseService {
	constructor(
		repo: RepositoryApi,
		private readonly branches: BranchService,
	) {
		super(repo);
	}

	async list(actor: Actor): Promise<Project[]> {
		if (actor.globalRole === "OWNER" || actor.globalRole === "ADMIN") {
			return this.repo.listProjectsByOrg(actor.orgId);
		}
		const memberships = await this.repo.listMembershipsByUser(actor.userId);
		const projects = await Promise.all(
			memberships.map((m) => this.repo.getProject(m.projectId)),
		);
		return projects.filter((p): p is Project => !!p && p.orgId === actor.orgId);
	}

	async get(actor: Actor, projectId: string): Promise<Project> {
		const { project } = await this.authorizeProject(
			actor,
			projectId,
			"project.read",
		);
		return project;
	}

	async create(actor: Actor, input: CreateProjectInput): Promise<Project> {
		requireOrg(actor, "project.create");
		const name = requireText(input.name, "name");
		const baseLocale = requireLocale(input.baseLocale, "baseLocale");
		const now = new Date().toISOString();
		const project: Project = {
			id: newId("proj"),
			orgId: actor.orgId,
			name,
			slug: slugify(name),
			description: input.description,
			baseLocale,
			contextRevision: 0,
			requireHumanAccept: false,
			createdAt: now,
			updatedAt: now,
		};
		await this.repo.createProject(project);
		// Every project starts with the root `main` branch.
		await this.branches.ensureMain(project.id, actor.userId);
		await this.repo.putLocale({
			projectId: project.id,
			code: baseLocale,
			name: baseLocale,
			lifecycle: "active",
			createdAt: now,
		});
		// The creator gets an explicit MANAGER membership so the project shows up in
		// their listings even if they are only a global MEMBER.
		await this.repo.putMembership({
			projectId: project.id,
			userId: actor.userId,
			role: "MANAGER",
			createdAt: now,
		});
		return project;
	}

	async update(
		actor: Actor,
		projectId: string,
		patch: {
			name?: string;
			description?: string;
			baseLocale?: string;
			requireHumanAccept?: boolean;
		},
	): Promise<Project> {
		await this.authorizeProject(actor, projectId, "project.update");
		if (patch.baseLocale !== undefined)
			patch.baseLocale = requireLocale(patch.baseLocale, "baseLocale");
		await this.repo.updateProject(projectId, patch);
		return (await this.repo.getProject(projectId))!;
	}

	/** Permanently delete a project and ALL of its data. Requires explicit confirm. */
	async delete(
		actor: Actor,
		projectId: string,
		confirm: boolean,
	): Promise<{ deleted: string }> {
		await this.authorizeProject(actor, projectId, "project.delete");
		if (!confirm) {
			throw validation(
				"Set confirm=true to permanently delete the project and all its data",
			);
		}
		const locales = await this.repo.listLocales(projectId);
		await this.repo.deleteProjectCascade(
			projectId,
			locales.map((l) => l.code),
		);
		return { deleted: projectId };
	}
}
