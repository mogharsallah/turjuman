import type { Actor, ImportKeysResult, Project } from "@turjuman/schema";
import {
	conflict,
	KEY_NAME_RE,
	MAIN_BRANCH_ID,
	newId,
	notFound,
	requirePattern,
	type Translation,
	type TranslationKey,
	validation,
} from "@turjuman/schema";
import type { RepositoryApi } from "../repository/index.js";
import { BaseService } from "./base.js";
import type { NamespaceService } from "./namespaces.js";
import { revisionOf } from "./revision.js";
import type {
	CreateKeyInput,
	KeyPage,
	KeyWithTranslations,
	UpdateKeyInput,
} from "./types.js";

/** A `(name, namespace, branch)` address resolving to one key. */
export interface KeyRef {
	name: string;
	namespace?: string;
	branch?: string;
}

export class KeysService extends BaseService {
	constructor(
		repo: RepositoryApi,
		private readonly namespaces: NamespaceService,
	) {
		super(repo);
	}

	async list(
		actor: Actor,
		projectId: string,
		filter: {
			branch?: string;
			namespace?: string;
			tag?: string;
			includeDeprecated?: boolean;
		} = {},
	): Promise<TranslationKey[]> {
		await this.authorizeProject(actor, projectId, "key.read");
		const branch = filter.branch ?? MAIN_BRANCH_ID;
		let keys = await this.repo.listKeyDefs(projectId, branch);
		if (!filter.includeDeprecated)
			keys = keys.filter((k) => k.state !== "deprecated");
		if (filter.namespace) {
			const nsId = await this.namespaces.idOf(projectId, filter.namespace);
			if (!nsId) return [];
			keys = keys.filter((k) => k.namespaceId === nsId);
		}
		if (filter.tag) keys = keys.filter((k) => k.tags.includes(filter.tag!));
		return keys;
	}

	/**
	 * List keys one page at a time, so large projects don't force a full-branch
	 * read on every call. `cursor` is the opaque `nextCursor` from a prior page.
	 * The namespace/tag filters are applied within the page (a page may therefore
	 * return fewer than `limit` keys while still yielding a cursor).
	 */
	async listPage(
		actor: Actor,
		projectId: string,
		opts: {
			branch?: string;
			namespace?: string;
			tag?: string;
			limit?: number;
			cursor?: string;
			includeDeprecated?: boolean;
		} = {},
	): Promise<KeyPage> {
		await this.authorizeProject(actor, projectId, "key.read");
		const branch = opts.branch ?? MAIN_BRANCH_ID;
		const page = await this.repo.listKeyDefsPage(projectId, branch, {
			limit: opts.limit,
			cursor: opts.cursor,
		});
		let keys = page.keys;
		if (!opts.includeDeprecated)
			keys = keys.filter((k) => k.state !== "deprecated");
		if (opts.namespace) {
			const nsId = await this.namespaces.idOf(projectId, opts.namespace);
			keys = nsId ? keys.filter((k) => k.namespaceId === nsId) : [];
		}
		if (opts.tag) keys = keys.filter((k) => k.tags.includes(opts.tag!));
		return { keys, nextCursor: page.nextCursor };
	}

	async search(
		actor: Actor,
		projectId: string,
		query: string,
		branch = MAIN_BRANCH_ID,
	): Promise<TranslationKey[]> {
		const keys = await this.list(actor, projectId, { branch });
		const q = query.toLowerCase();
		return keys.filter((k) => this.matchesQuery(k, q));
	}

	/**
	 * Search keys one page at a time. Pages the underlying key partition via the
	 * cursor and applies the substring match within each page; like {@link listPage}
	 * a page may return fewer than `limit` keys while still yielding a `nextCursor`.
	 */
	async searchPage(
		actor: Actor,
		projectId: string,
		query: string,
		opts: { branch?: string; limit?: number; cursor?: string } = {},
	): Promise<KeyPage> {
		await this.authorizeProject(actor, projectId, "key.read");
		const page = await this.repo.listKeyDefsPage(
			projectId,
			opts.branch ?? MAIN_BRANCH_ID,
			{ limit: opts.limit, cursor: opts.cursor },
		);
		const q = query.toLowerCase();
		const keys = page.keys.filter(
			(k) => k.state !== "deprecated" && this.matchesQuery(k, q),
		);
		return { keys, nextCursor: page.nextCursor };
	}

	/** Substring match of a key's name, description, or tags against a lower-cased query. */
	private matchesQuery(k: TranslationKey, lowerQuery: string): boolean {
		return (
			k.name.toLowerCase().includes(lowerQuery) ||
			(k.description ?? "").toLowerCase().includes(lowerQuery) ||
			k.tags.some((t) => t.toLowerCase().includes(lowerQuery))
		);
	}

	async get(
		actor: Actor,
		projectId: string,
		name: string,
		namespace?: string,
		branch = MAIN_BRANCH_ID,
	): Promise<KeyWithTranslations> {
		await this.authorizeProject(actor, projectId, "key.read");
		const { keyId, key } = await this.resolveKey(
			projectId,
			branch,
			name,
			namespace,
		);
		const translations = await this.repo.listCellsByKey(
			projectId,
			branch,
			keyId,
		);
		return { key, translations };
	}

	async create(
		actor: Actor,
		projectId: string,
		input: CreateKeyInput,
	): Promise<TranslationKey> {
		const { project } = await this.authorizeProject(
			actor,
			projectId,
			"key.manage",
		);
		const branch = input.branch ?? MAIN_BRANCH_ID;
		const ns = await this.namespaces.ensure(projectId, input.namespace);
		const name = requirePattern(input.name, KEY_NAME_RE, "name");
		if (await this.repo.resolveKeyIdByName(projectId, branch, ns?.id, name))
			throw conflict(`Key "${name}" already exists`);
		const now = new Date().toISOString();
		const key: TranslationKey = {
			id: newId("key"),
			projectId,
			namespaceId: ns?.id,
			name,
			description: input.description,
			plural: input.plural ?? false,
			maxLength: input.maxLength,
			tags: input.tags ?? [],
			state: "active",
			sourceRevision: revisionOf(input.baseValue),
			introducedOnBranchId: branch,
			lastSeenAt: now,
			createdAt: now,
			updatedAt: now,
		};
		await this.repo.createKeyDef(branch, key);
		if (input.baseValue !== undefined)
			await this.repo.putCell(
				this.baseCell(
					project,
					branch,
					key.id,
					input.baseValue,
					actor.userId,
					now,
				),
			);
		return key;
	}

	/**
	 * Create-or-update many keys in one namespace and optionally set their base
	 * locale values (the CLI `push`). The permission check runs once for the batch.
	 *
	 * Keys present in `entries` are (re)activated and their `lastSeenAt` bumped; a
	 * changed base value bumps the key's `sourceRevision` (staling its dependents).
	 * Keys absent from `entries` are left untouched by default; `deprecateAbsent`
	 * soft-deprecates them (retained, hidden, restored if they return) and `prune`
	 * hard-deletes them with their cells — so a full-file push makes the file the
	 * source of truth for its namespace.
	 */
	async import(
		actor: Actor,
		projectId: string,
		entries: {
			name: string;
			description?: string;
			baseValue?: string;
			plural?: boolean;
		}[],
		namespace?: string,
		opts: { branch?: string; prune?: boolean; deprecateAbsent?: boolean } = {},
	): Promise<ImportKeysResult> {
		const { project } = await this.authorizeProject(
			actor,
			projectId,
			"key.manage",
		);
		const branch = opts.branch ?? MAIN_BRANCH_ID;
		const ns = await this.namespaces.ensure(projectId, namespace);
		const existing = new Map(
			(await this.repo.listKeyDefs(projectId, branch))
				.filter((k) => k.namespaceId === ns?.id)
				.map((k) => [k.name, k]),
		);
		const now = new Date().toISOString();
		const baseCells: Translation[] = [];
		const seen = new Set<string>();
		let created = 0;
		let updated = 0;
		let reactivated = 0;
		for (const entry of entries) {
			const name = requirePattern(entry.name, KEY_NAME_RE, "name");
			seen.add(name);
			const newRev =
				entry.baseValue !== undefined ? revisionOf(entry.baseValue) : undefined;
			const prev = existing.get(name);
			if (prev) {
				const nextDescription = entry.description ?? prev.description;
				const nextPlural = entry.plural ?? prev.plural;
				const metadataChanged =
					nextDescription !== prev.description || nextPlural !== prev.plural;
				const wasDeprecated = prev.state === "deprecated";
				const revChanged =
					newRev !== undefined && newRev !== prev.sourceRevision;
				if (metadataChanged || wasDeprecated || revChanged) {
					await this.repo.putKeyDef(branch, {
						...prev,
						description: nextDescription,
						plural: nextPlural,
						sourceRevision: revChanged ? newRev! : prev.sourceRevision,
						state: "active",
						lastSeenAt: now,
						updatedAt: now,
					});
					if (metadataChanged) updated++;
					if (wasDeprecated) reactivated++;
				}
				if (entry.baseValue !== undefined)
					baseCells.push(
						this.baseCell(
							project,
							branch,
							prev.id,
							entry.baseValue,
							actor.userId,
							now,
						),
					);
			} else {
				const key: TranslationKey = {
					id: newId("key"),
					projectId,
					namespaceId: ns?.id,
					name,
					description: entry.description,
					plural: entry.plural ?? false,
					tags: [],
					state: "active",
					sourceRevision: newRev ?? "",
					introducedOnBranchId: branch,
					lastSeenAt: now,
					createdAt: now,
					updatedAt: now,
				};
				await this.repo.createKeyDef(branch, key);
				created++;
				if (entry.baseValue !== undefined)
					baseCells.push(
						this.baseCell(
							project,
							branch,
							key.id,
							entry.baseValue,
							actor.userId,
							now,
						),
					);
			}
		}
		await this.repo.putCells(baseCells);

		const absent = [...existing.values()].filter((k) => !seen.has(k.name));
		let deleted = 0;
		let deprecated = 0;
		if (opts.prune) {
			if (absent.length > 0)
				await this.repo.deleteKeyDefsCascade(
					projectId,
					branch,
					absent.map((k) => ({
						id: k.id,
						namespaceId: k.namespaceId,
						name: k.name,
					})),
				);
			deleted = absent.length;
		} else if (opts.deprecateAbsent) {
			for (const k of absent) {
				if (k.state !== "deprecated") {
					await this.repo.putKeyDef(branch, {
						...k,
						state: "deprecated",
						updatedAt: now,
					});
					deprecated++;
				}
			}
		}
		return {
			created,
			updated,
			reactivated,
			baseValuesSet: baseCells.length,
			deleted,
			deprecated,
		};
	}

	async update(
		actor: Actor,
		projectId: string,
		name: string,
		patch: UpdateKeyInput,
		namespace?: string,
		branch = MAIN_BRANCH_ID,
	): Promise<TranslationKey> {
		await this.authorizeProject(actor, projectId, "key.manage");
		const { key } = await this.resolveKey(projectId, branch, name, namespace);
		const updated: TranslationKey = {
			...key,
			description: patch.description ?? key.description,
			plural: patch.plural ?? key.plural,
			maxLength: patch.maxLength ?? key.maxLength,
			tags: patch.tags ?? key.tags,
			noTranslate: patch.noTranslate ?? key.noTranslate,
			updatedAt: new Date().toISOString(),
		};
		return this.repo.putKeyDef(branch, updated);
	}

	/**
	 * Move a key to a new name and/or namespace. Identity (`keyId`) and all of the
	 * key's translations are unaffected — only the labels and the name-lookup row
	 * change. Conflicts if the destination name is already taken.
	 */
	async rename(
		actor: Actor,
		projectId: string,
		name: string,
		to: { name?: string; namespace?: string },
		namespace?: string,
		branch = MAIN_BRANCH_ID,
	): Promise<TranslationKey> {
		await this.authorizeProject(actor, projectId, "key.manage");
		const { key } = await this.resolveKey(projectId, branch, name, namespace);
		const newName =
			to.name !== undefined
				? requirePattern(to.name, KEY_NAME_RE, "name")
				: key.name;
		const newNamespaceId =
			to.namespace !== undefined
				? (await this.namespaces.ensure(projectId, to.namespace))?.id
				: key.namespaceId;
		const updated: TranslationKey = {
			...key,
			name: newName,
			namespaceId: newNamespaceId,
			updatedAt: new Date().toISOString(),
		};
		return this.repo.renameKeyDef(branch, updated, {
			namespaceId: key.namespaceId,
			name: key.name,
		});
	}

	/**
	 * Hard-delete a key and all of its translations across every locale. Like
	 * {@link ProjectsService.delete} this cascade is irreversible, so it requires
	 * an explicit `confirm` — defense in depth alongside the tool's destructive hint.
	 */
	async delete(
		actor: Actor,
		projectId: string,
		name: string,
		confirm: boolean,
		namespace?: string,
		branch = MAIN_BRANCH_ID,
	): Promise<void> {
		await this.authorizeProject(actor, projectId, "key.manage");
		if (!confirm) {
			throw validation(
				"Set confirm=true to permanently delete the key and all its translations",
			);
		}
		const { key } = await this.resolveKey(projectId, branch, name, namespace);
		await this.repo.deleteKeyDefsCascade(projectId, branch, [
			{ id: key.id, namespaceId: key.namespaceId, name: key.name },
		]);
	}

	// ---- internals ------------------------------------------------------------

	/** Resolve a `(name, namespace)` label to its key id + definition, or NOT_FOUND. */
	private async resolveKey(
		projectId: string,
		branch: string,
		name: string,
		namespace?: string,
	): Promise<{ keyId: string; key: TranslationKey }> {
		const nsId = await this.namespaces.idOf(projectId, namespace);
		if (namespace && !nsId)
			throw notFound(`Key ${namespace}/${name} not found`);
		const keyId = await this.repo.resolveKeyIdByName(
			projectId,
			branch,
			nsId,
			name,
		);
		const key = keyId
			? await this.repo.getKeyDef(projectId, branch, keyId)
			: undefined;
		if (!keyId || !key) throw notFound(`Key ${name} not found`);
		return { keyId, key };
	}

	/** The base-locale cell for a key: the authoritative source value (accepted,
	 * no upstream `sourceRef`). */
	private baseCell(
		project: Project,
		branch: string,
		keyId: string,
		value: string,
		userId: string,
		now: string,
	): Translation {
		return {
			projectId: project.id,
			branchId: branch,
			keyId,
			locale: project.baseLocale,
			value,
			lifecycle: "accepted",
			stale: false,
			origin: "import",
			updatedBy: userId,
			updatedAt: now,
		};
	}
}
