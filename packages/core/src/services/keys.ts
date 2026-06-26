import type { Actor, ImportKeysResult } from "@turjuman/schema";
import {
	conflict,
	DEFAULT_NAMESPACE,
	KEY_NAME_RE,
	NAMESPACE_RE,
	notFound,
	requirePattern,
	type Translation,
	type TranslationKey,
	validation,
} from "@turjuman/schema";
import { BaseService } from "./base.js";
import type {
	CreateKeyInput,
	KeyPage,
	KeyWithTranslations,
	UpdateKeyInput,
} from "./types.js";

export class KeysService extends BaseService {
	async list(
		actor: Actor,
		projectId: string,
		filter: {
			namespace?: string;
			tag?: string;
			includeDeprecated?: boolean;
		} = {},
	): Promise<TranslationKey[]> {
		await this.authorizeProject(actor, projectId, "key.read");
		let keys = await this.repo.listKeys(projectId, filter.namespace);
		if (!filter.includeDeprecated)
			keys = keys.filter((k) => k.state !== "deprecated");
		if (filter.tag) keys = keys.filter((k) => k.tags.includes(filter.tag!));
		return keys;
	}

	/**
	 * List keys one page at a time, so large projects don't force a full-table
	 * read on every call. `cursor` is the opaque `nextCursor` from a prior page.
	 * A `tag` filter is applied within the page (a page may therefore return
	 * fewer than `limit` keys while still yielding a cursor).
	 */
	async listPage(
		actor: Actor,
		projectId: string,
		opts: {
			namespace?: string;
			tag?: string;
			limit?: number;
			cursor?: string;
			includeDeprecated?: boolean;
		} = {},
	): Promise<KeyPage> {
		await this.authorizeProject(actor, projectId, "key.read");
		const page = await this.repo.listKeysPage(projectId, {
			namespace: opts.namespace,
			limit: opts.limit,
			cursor: opts.cursor,
		});
		let keys = page.keys;
		if (!opts.includeDeprecated)
			keys = keys.filter((k) => k.state !== "deprecated");
		if (opts.tag) keys = keys.filter((k) => k.tags.includes(opts.tag!));
		return { keys, nextCursor: page.nextCursor };
	}

	async search(
		actor: Actor,
		projectId: string,
		query: string,
	): Promise<TranslationKey[]> {
		const keys = await this.list(actor, projectId);
		const q = query.toLowerCase();
		return keys.filter((k) => this.matchesQuery(k, q));
	}

	/**
	 * Search keys one page at a time, so a large project isn't fully scanned on
	 * every call. Pages the underlying key partition via the cursor and applies
	 * the substring match within each page; like {@link listPage}, a page may
	 * therefore return fewer than `limit` keys (non-matches and deprecated keys
	 * are filtered out) while still yielding a `nextCursor` to continue.
	 */
	async searchPage(
		actor: Actor,
		projectId: string,
		query: string,
		opts: { limit?: number; cursor?: string } = {},
	): Promise<KeyPage> {
		await this.authorizeProject(actor, projectId, "key.read");
		const page = await this.repo.listKeysPage(projectId, {
			limit: opts.limit,
			cursor: opts.cursor,
		});
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
		namespace = DEFAULT_NAMESPACE,
	): Promise<KeyWithTranslations> {
		await this.authorizeProject(actor, projectId, "key.read");
		const key = await this.repo.getKey(projectId, namespace, name);
		if (!key) throw notFound(`Key ${namespace}/${name} not found`);
		const translations = await this.repo.listTranslationsByKey(
			projectId,
			namespace,
			name,
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
		const namespace = requirePattern(
			input.namespace ?? DEFAULT_NAMESPACE,
			NAMESPACE_RE,
			"namespace",
		);
		const name = requirePattern(input.name, KEY_NAME_RE, "name");
		if (await this.repo.getKey(projectId, namespace, name)) {
			throw conflict(`Key ${namespace}/${name} already exists`);
		}
		const now = new Date().toISOString();
		const key: TranslationKey = {
			projectId,
			namespace,
			name,
			description: input.description,
			plural: input.plural ?? false,
			maxLength: input.maxLength,
			tags: input.tags ?? [],
			state: "active",
			lastSeenAt: now,
			createdAt: now,
			updatedAt: now,
		};
		await this.repo.putKey(key);
		if (input.baseValue !== undefined) {
			await this.repo.putTranslation({
				projectId,
				localeCode: project.baseLocale,
				namespace,
				keyName: name,
				value: input.baseValue,
				status: "translated",
				origin: "import",
				updatedBy: actor.userId,
				updatedAt: now,
			});
		}
		return key;
	}

	/**
	 * Create-or-update many keys in one namespace and optionally set their base
	 * locale values. Used by the CLI `push` (deterministic source upload). The
	 * permission check runs once for the whole batch.
	 *
	 * Keys present in `entries` are (re)activated and their `lastSeenAt` bumped.
	 * Handling of keys that exist in the namespace but are absent from `entries`
	 * depends on the mode (default: leave them untouched — a plain additive
	 * import): with `deprecateAbsent` they are soft-**deprecated** (retained,
	 * hidden from listing/export, restored if they return); with `prune` they are
	 * hard-deleted along with their translations. A full-file `push` opts into one
	 * of these so the file becomes the source of truth for its namespace.
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
		namespace = DEFAULT_NAMESPACE,
		opts: { prune?: boolean; deprecateAbsent?: boolean } = {},
	): Promise<ImportKeysResult> {
		const { project } = await this.authorizeProject(
			actor,
			projectId,
			"key.manage",
		);
		const ns = requirePattern(namespace, NAMESPACE_RE, "namespace");
		const existing = new Map(
			(await this.repo.listKeys(projectId, ns)).map((k) => [k.name, k]),
		);
		const now = new Date().toISOString();
		const baseTranslations: Translation[] = [];
		const seen = new Set<string>();
		let created = 0;
		let updated = 0;
		let reactivated = 0;
		for (const entry of entries) {
			const name = requirePattern(entry.name, KEY_NAME_RE, "name");
			seen.add(name);
			const prev = existing.get(name);
			if (prev) {
				const nextDescription = entry.description ?? prev.description;
				const nextPlural = entry.plural ?? prev.plural;
				const metadataChanged =
					nextDescription !== prev.description || nextPlural !== prev.plural;
				const wasDeprecated = prev.state === "deprecated";
				if (metadataChanged || wasDeprecated) {
					await this.repo.putKey({
						...prev,
						description: nextDescription,
						plural: nextPlural,
						state: "active",
						lastSeenAt: now,
						updatedAt: now,
					});
					if (metadataChanged) updated++;
					if (wasDeprecated) reactivated++;
				}
			} else {
				await this.repo.putKey({
					projectId,
					namespace: ns,
					name,
					description: entry.description,
					plural: entry.plural ?? false,
					tags: [],
					state: "active",
					lastSeenAt: now,
					createdAt: now,
					updatedAt: now,
				});
				created++;
			}
			if (entry.baseValue !== undefined) {
				baseTranslations.push({
					projectId,
					localeCode: project.baseLocale,
					namespace: ns,
					keyName: name,
					value: entry.baseValue,
					status: "translated",
					origin: "import",
					updatedBy: actor.userId,
					updatedAt: now,
				});
			}
		}
		await this.repo.putTranslations(baseTranslations);

		// Keys absent from this import: hard-delete with `prune`, soft-deprecate with
		// `deprecateAbsent`, otherwise leave untouched (a plain additive import).
		const absent = [...existing.values()].filter((k) => !seen.has(k.name));
		let deleted = 0;
		let deprecated = 0;
		if (opts.prune) {
			const names = absent.map((k) => k.name);
			if (names.length > 0)
				await this.repo.deleteKeysCascade(projectId, ns, names);
			deleted = names.length;
		} else if (opts.deprecateAbsent) {
			for (const k of absent) {
				if (k.state !== "deprecated") {
					await this.repo.putKey({ ...k, state: "deprecated", updatedAt: now });
					deprecated++;
				}
			}
		}
		return {
			created,
			updated,
			reactivated,
			baseValuesSet: baseTranslations.length,
			deleted,
			deprecated,
		};
	}

	async update(
		actor: Actor,
		projectId: string,
		name: string,
		patch: UpdateKeyInput,
		namespace = DEFAULT_NAMESPACE,
	): Promise<TranslationKey> {
		await this.authorizeProject(actor, projectId, "key.manage");
		const key = await this.repo.getKey(projectId, namespace, name);
		if (!key) throw notFound(`Key ${namespace}/${name} not found`);
		const updated: TranslationKey = {
			...key,
			description: patch.description ?? key.description,
			plural: patch.plural ?? key.plural,
			maxLength: patch.maxLength ?? key.maxLength,
			tags: patch.tags ?? key.tags,
			updatedAt: new Date().toISOString(),
		};
		return this.repo.putKey(updated);
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
		namespace = DEFAULT_NAMESPACE,
	): Promise<void> {
		await this.authorizeProject(actor, projectId, "key.manage");
		if (!confirm) {
			throw validation(
				"Set confirm=true to permanently delete the key and all its translations",
			);
		}
		await this.repo.deleteKeysCascade(projectId, namespace, [name]);
	}
}
