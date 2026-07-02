import type { Actor, Namespace } from "@turjuman/schema";
import {
	conflict,
	NAMESPACE_RE,
	newId,
	notFound,
	requirePattern,
} from "@turjuman/schema";
import { BaseService } from "./base.js";

export interface CreateNamespaceInput {
	name: string;
	title?: string;
	description?: string;
}

export interface UpdateNamespaceInput {
	name?: string;
	title?: string;
	description?: string;
	lifecycle?: Namespace["lifecycle"];
}

/**
 * Namespaces: opaque-id groupings of keys by feature-area. The `name` is a
 * renamable display label, unique per project; keys reference the `id`, never the
 * name, so a namespace can be renamed without touching any key. (Its richer
 * "voice" / context-carrier role arrives with the cascade in a later batch.)
 */
export class NamespaceService extends BaseService {
	async list(actor: Actor, projectId: string): Promise<Namespace[]> {
		await this.authorizeProject(actor, projectId, "key.read");
		return this.repo.listNamespaces(projectId);
	}

	async get(
		actor: Actor,
		projectId: string,
		namespaceId: string,
	): Promise<Namespace> {
		await this.authorizeProject(actor, projectId, "key.read");
		const ns = await this.repo.getNamespace(projectId, namespaceId);
		if (!ns) throw notFound(`Namespace ${namespaceId} not found`);
		return ns;
	}

	async create(
		actor: Actor,
		projectId: string,
		input: CreateNamespaceInput,
	): Promise<Namespace> {
		await this.authorizeProject(actor, projectId, "key.manage");
		const name = requirePattern(input.name, NAMESPACE_RE, "namespace");
		const existing = await this.findByName(projectId, name);
		if (existing) throw conflict(`Namespace "${name}" already exists`);
		return this.write(projectId, {
			name,
			title: input.title,
			description: input.description,
		});
	}

	async update(
		actor: Actor,
		projectId: string,
		namespaceId: string,
		patch: UpdateNamespaceInput,
	): Promise<Namespace> {
		await this.authorizeProject(actor, projectId, "key.manage");
		const ns = await this.repo.getNamespace(projectId, namespaceId);
		if (!ns) throw notFound(`Namespace ${namespaceId} not found`);
		const name =
			patch.name !== undefined
				? requirePattern(patch.name, NAMESPACE_RE, "namespace")
				: ns.name;
		if (name !== ns.name && (await this.findByName(projectId, name)))
			throw conflict(`Namespace "${name}" already exists`);
		const updated: Namespace = {
			...ns,
			name,
			title: patch.title ?? ns.title,
			description: patch.description ?? ns.description,
			lifecycle: patch.lifecycle ?? ns.lifecycle,
			updatedAt: new Date().toISOString(),
		};
		return this.repo.putNamespace(updated);
	}

	// ---- internal (trusted; caller authorizes) --------------------------------

	/**
	 * Resolve a namespace name to its entity, creating it on first use. Called by
	 * the key import path, which has already authorized `key.manage` — so this does
	 * no RBAC of its own. An empty/absent name means "no namespace" and yields
	 * `undefined`.
	 */
	async ensure(
		projectId: string,
		name: string | undefined,
	): Promise<Namespace | undefined> {
		const trimmed = name?.trim();
		if (!trimmed) return undefined;
		const valid = requirePattern(trimmed, NAMESPACE_RE, "namespace");
		return (
			(await this.findByName(projectId, valid)) ??
			(await this.write(projectId, { name: valid }))
		);
	}

	/** Map of `namespaceId -> name` for the project (for finding coordinates). */
	async nameMap(projectId: string): Promise<Map<string, string>> {
		const list = await this.repo.listNamespaces(projectId);
		return new Map(list.map((n) => [n.id, n.name]));
	}

	/** Resolve a namespace name to its id without creating it (`undefined` for an
	 * empty/absent name or a name that does not exist). */
	async idOf(
		projectId: string,
		name: string | undefined,
	): Promise<string | undefined> {
		const trimmed = name?.trim();
		if (!trimmed) return undefined;
		return (await this.findByName(projectId, trimmed))?.id;
	}

	private async findByName(
		projectId: string,
		name: string,
	): Promise<Namespace | undefined> {
		return (await this.repo.listNamespaces(projectId)).find(
			(n) => n.name === name,
		);
	}

	private async write(
		projectId: string,
		input: CreateNamespaceInput,
	): Promise<Namespace> {
		const now = new Date().toISOString();
		return this.repo.putNamespace({
			id: newId("ns"),
			projectId,
			name: input.name,
			title: input.title,
			description: input.description,
			lifecycle: "active",
			createdAt: now,
			updatedAt: now,
		});
	}
}
