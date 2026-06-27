import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
	BatchWriteCommand,
	DeleteCommand,
	DynamoDBDocumentClient,
	GetCommand,
	PutCommand,
	QueryCommand,
	type QueryCommandInput,
	TransactWriteCommand,
	UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type {
	ApiKey,
	GlobalRole,
	GlossaryTerm,
	Locale,
	Membership,
	Project,
	QaConfig,
	ScoreConfig,
	Translation,
	TranslationKey,
	User,
	Webhook,
} from "@turjuman/schema";
import { conflict } from "@turjuman/schema";
import { decodeCursor, encodeCursor } from "./cursor.js";
import type { IndexName, Item } from "./item.js";
import {
	apiKeyPK,
	emailPK,
	glossarySK,
	keyGSI3PK,
	keySK,
	localeSK,
	memberSK,
	orgGSI1PK,
	orgOwnerPK,
	projectPK,
	qaConfigSK,
	scoreConfigSK,
	transPK,
	userPK,
	webhookSK,
} from "./keys.js";
import {
	isConditionalFailure,
	toApiKey,
	toGlossaryTerm,
	toKey,
	toLocale,
	toMembership,
	toProject,
	toQaConfig,
	toScoreConfig,
	toTranslation,
	toUser,
	toWebhook,
	translationItem,
} from "./mappers.js";

/**
 * Single-table DynamoDB repository.
 *
 * Key design (see plan). All GSIs are assumed to project ALL attributes.
 *   GSI1 — "by org": list projects/users in an org.
 *   GSI2 — "by user": memberships and API keys belonging to a user.
 *   GSI3 — "by key":  every locale's translation for one key.
 *
 * Uniqueness (email) is enforced with a companion lookup item written in the
 * same transaction. Direct-get lookups (API key by hash, email -> userId) avoid
 * extra GSIs entirely.
 *
 * Almost every method is a thin wrapper over four private primitives — getItem,
 * listByPrefix, putItem, deleteItem — so the per-entity methods only declare
 * their keys and mapper. The bespoke operations that don't fit (the email
 * uniqueness transaction, batched writes, the paginated key query, and the
 * GSI3 PK-only translation query) keep their own command bodies. The PK/SK
 * builders live in ./keys.ts, the Item<->domain mappers in ./mappers.ts.
 */

export interface RepositoryOptions {
	tableName: string;
	/** Optional override (used for dynamodb-local in tests). */
	client?: DynamoDBClient;
}

export class Repository {
	private readonly doc: DynamoDBDocumentClient;
	private readonly table: string;

	constructor(opts: RepositoryOptions) {
		const base = opts.client ?? new DynamoDBClient({});
		this.doc = DynamoDBDocumentClient.from(base, {
			marshallOptions: { removeUndefinedValues: true },
		});
		this.table = opts.tableName;
	}

	// ---- users ----------------------------------------------------------------

	/** Create a user and reserve its email atomically. Throws CONFLICT on a dup email. */
	async createUser(user: User): Promise<User> {
		try {
			await this.doc.send(
				new TransactWriteCommand({
					TransactItems: [
						{
							Put: {
								TableName: this.table,
								Item: {
									PK: userPK(user.id),
									SK: userPK(user.id),
									GSI1PK: orgGSI1PK(user.orgId),
									GSI1SK: userPK(user.id),
									entityType: "User",
									...user,
								} satisfies Item,
								ConditionExpression: "attribute_not_exists(PK)",
							},
						},
						{
							Put: {
								TableName: this.table,
								Item: {
									PK: emailPK(user.email),
									SK: emailPK(user.email),
									entityType: "UserEmail",
									userId: user.id,
								} satisfies Item,
								ConditionExpression: "attribute_not_exists(PK)",
							},
						},
					],
				}),
			);
		} catch (err) {
			if (isConditionalFailure(err))
				throw conflict(`Email ${user.email} is already in use`);
			throw err;
		}
		return user;
	}

	async getUser(userId: string): Promise<User | undefined> {
		return this.getItem(userPK(userId), userPK(userId), toUser);
	}

	async getUserByEmail(email: string): Promise<User | undefined> {
		const userId = await this.getItem(
			emailPK(email),
			emailPK(email),
			(i) => i.userId as string,
		);
		return userId ? this.getUser(userId) : undefined;
	}

	async listUsersByOrg(orgId: string): Promise<User[]> {
		return this.listByPrefix(orgGSI1PK(orgId), "USER#", toUser, "GSI1");
	}

	async setUserGlobalRole(userId: string, role: GlobalRole): Promise<void> {
		await this.doc.send(
			new UpdateCommand({
				TableName: this.table,
				Key: { PK: userPK(userId), SK: userPK(userId) },
				UpdateExpression: "SET globalRole = :r, updatedAt = :t",
				ExpressionAttributeValues: {
					":r": role,
					":t": new Date().toISOString(),
				},
				ConditionExpression: "attribute_exists(PK)",
			}),
		);
	}

	// ---- api keys -------------------------------------------------------------

	async createApiKey(key: ApiKey): Promise<ApiKey> {
		await this.putItem({
			PK: apiKeyPK(key.hash),
			SK: apiKeyPK(key.hash),
			GSI2PK: userPK(key.userId),
			GSI2SK: `APIKEY#${key.id}`,
			entityType: "ApiKey",
			...key,
		});
		return key;
	}

	/**
	 * Atomically create the first OWNER of an org together with its initial API
	 * key. A single `TransactWriteItems` writes the user, the email-uniqueness
	 * companion, an **org-owner sentinel** (`orgOwnerPK`), and the key — every Put
	 * guarded by `attribute_not_exists(PK)`. The sentinel is what makes the
	 * single-owner invariant race-safe: two concurrent first-owner requests (e.g.
	 * against the unauthenticated `POST /v1/bootstrap`) can't both win — the loser's
	 * conditional check fails and the whole transaction rolls back, so a second
	 * OWNER is never written. Bundling the key in the same transaction also removes
	 * the half-state where an owner exists with no key.
	 */
	async createOwnerWithKey(user: User, key: ApiKey): Promise<void> {
		try {
			await this.doc.send(
				new TransactWriteCommand({
					TransactItems: [
						{
							Put: {
								TableName: this.table,
								Item: {
									PK: userPK(user.id),
									SK: userPK(user.id),
									GSI1PK: orgGSI1PK(user.orgId),
									GSI1SK: userPK(user.id),
									entityType: "User",
									...user,
								} satisfies Item,
								ConditionExpression: "attribute_not_exists(PK)",
							},
						},
						{
							Put: {
								TableName: this.table,
								Item: {
									PK: emailPK(user.email),
									SK: emailPK(user.email),
									entityType: "UserEmail",
									userId: user.id,
								} satisfies Item,
								ConditionExpression: "attribute_not_exists(PK)",
							},
						},
						{
							Put: {
								TableName: this.table,
								Item: {
									PK: orgOwnerPK(user.orgId),
									SK: orgOwnerPK(user.orgId),
									entityType: "OrgOwner",
									userId: user.id,
								} satisfies Item,
								ConditionExpression: "attribute_not_exists(PK)",
							},
						},
						{
							Put: {
								TableName: this.table,
								Item: {
									PK: apiKeyPK(key.hash),
									SK: apiKeyPK(key.hash),
									GSI2PK: userPK(key.userId),
									GSI2SK: `APIKEY#${key.id}`,
									entityType: "ApiKey",
									...key,
								} satisfies Item,
								ConditionExpression: "attribute_not_exists(PK)",
							},
						},
					],
				}),
			);
		} catch (err) {
			if (isConditionalFailure(err))
				throw conflict(
					`This deployment already has an owner (or the email ${user.email} is in use).`,
				);
			throw err;
		}
	}

	async getApiKeyByHash(hash: string): Promise<ApiKey | undefined> {
		return this.getItem(apiKeyPK(hash), apiKeyPK(hash), toApiKey);
	}

	async listApiKeysByUser(userId: string): Promise<ApiKey[]> {
		return this.listByPrefix(userPK(userId), "APIKEY#", toApiKey, "GSI2");
	}

	/** Best-effort lastUsedAt bump; never blocks the request path. */
	async touchApiKey(hash: string): Promise<void> {
		await this.doc
			.send(
				new UpdateCommand({
					TableName: this.table,
					Key: { PK: apiKeyPK(hash), SK: apiKeyPK(hash) },
					UpdateExpression: "SET lastUsedAt = :t",
					ExpressionAttributeValues: { ":t": new Date().toISOString() },
					ConditionExpression: "attribute_exists(PK)",
				}),
			)
			.catch(() => undefined);
	}

	async deleteApiKey(hash: string): Promise<void> {
		await this.deleteItem(apiKeyPK(hash), apiKeyPK(hash));
	}

	// ---- projects -------------------------------------------------------------

	async createProject(project: Project): Promise<Project> {
		await this.putItem(
			{
				PK: projectPK(project.id),
				SK: projectPK(project.id),
				GSI1PK: orgGSI1PK(project.orgId),
				GSI1SK: projectPK(project.id),
				entityType: "Project",
				...project,
			},
			"attribute_not_exists(PK)",
		);
		return project;
	}

	async getProject(projectId: string): Promise<Project | undefined> {
		return this.getItem(projectPK(projectId), projectPK(projectId), toProject);
	}

	async listProjectsByOrg(orgId: string): Promise<Project[]> {
		return this.listByPrefix(orgGSI1PK(orgId), "PROJECT#", toProject, "GSI1");
	}

	async updateProject(
		projectId: string,
		patch: Partial<Pick<Project, "name" | "description" | "baseLocale">>,
	): Promise<void> {
		const sets: string[] = ["updatedAt = :t"];
		const values: Record<string, unknown> = { ":t": new Date().toISOString() };
		if (patch.name !== undefined)
			sets.push("#n = :n"), (values[":n"] = patch.name);
		if (patch.description !== undefined)
			sets.push("description = :d"), (values[":d"] = patch.description);
		if (patch.baseLocale !== undefined)
			sets.push("baseLocale = :b"), (values[":b"] = patch.baseLocale);
		await this.doc.send(
			new UpdateCommand({
				TableName: this.table,
				Key: { PK: projectPK(projectId), SK: projectPK(projectId) },
				UpdateExpression: `SET ${sets.join(", ")}`,
				ExpressionAttributeValues: values,
				ExpressionAttributeNames:
					patch.name !== undefined ? { "#n": "name" } : undefined,
				ConditionExpression: "attribute_exists(PK)",
			}),
		);
	}

	// ---- memberships ----------------------------------------------------------

	async putMembership(m: Membership): Promise<Membership> {
		await this.putItem({
			PK: projectPK(m.projectId),
			SK: memberSK(m.userId),
			GSI2PK: userPK(m.userId),
			GSI2SK: projectPK(m.projectId),
			entityType: "Membership",
			...m,
		});
		return m;
	}

	async getMembership(
		projectId: string,
		userId: string,
	): Promise<Membership | undefined> {
		return this.getItem(projectPK(projectId), memberSK(userId), toMembership);
	}

	async listMembersByProject(projectId: string): Promise<Membership[]> {
		return this.listByPrefix(projectPK(projectId), "MEMBER#", toMembership);
	}

	async listMembershipsByUser(userId: string): Promise<Membership[]> {
		return this.listByPrefix(userPK(userId), "PROJECT#", toMembership, "GSI2");
	}

	async deleteMembership(projectId: string, userId: string): Promise<void> {
		await this.deleteItem(projectPK(projectId), memberSK(userId));
	}

	// ---- locales --------------------------------------------------------------

	async putLocale(locale: Locale): Promise<Locale> {
		await this.putItem({
			PK: projectPK(locale.projectId),
			SK: localeSK(locale.code),
			entityType: "Locale",
			...locale,
		});
		return locale;
	}

	async getLocale(
		projectId: string,
		code: string,
	): Promise<Locale | undefined> {
		return this.getItem(projectPK(projectId), localeSK(code), toLocale);
	}

	async listLocales(projectId: string): Promise<Locale[]> {
		return this.listByPrefix(projectPK(projectId), "LOCALE#", toLocale);
	}

	async deleteLocale(projectId: string, code: string): Promise<void> {
		await this.deleteItem(projectPK(projectId), localeSK(code));
	}

	// ---- translation keys -----------------------------------------------------

	async putKey(key: TranslationKey): Promise<TranslationKey> {
		await this.putItem({
			PK: projectPK(key.projectId),
			SK: keySK(key.namespace, key.name),
			entityType: "TranslationKey",
			...key,
		});
		return key;
	}

	async getKey(
		projectId: string,
		namespace: string,
		name: string,
	): Promise<TranslationKey | undefined> {
		return this.getItem(projectPK(projectId), keySK(namespace, name), toKey);
	}

	/** List keys for a project, optionally constrained to a single namespace. */
	async listKeys(
		projectId: string,
		namespace?: string,
	): Promise<TranslationKey[]> {
		const prefix = namespace ? `KEY#${namespace}#` : "KEY#";
		return this.listByPrefix(projectPK(projectId), prefix, toKey);
	}

	/**
	 * List one page of keys. `cursor` is the opaque token returned as `nextCursor`
	 * from a previous page; omit it for the first page.
	 */
	async listKeysPage(
		projectId: string,
		opts: { namespace?: string; limit?: number; cursor?: string } = {},
	): Promise<{ keys: TranslationKey[]; nextCursor?: string }> {
		const prefix = opts.namespace ? `KEY#${opts.namespace}#` : "KEY#";
		const res = await this.doc.send(
			new QueryCommand({
				TableName: this.table,
				KeyConditionExpression: "PK = :p AND begins_with(SK, :s)",
				ExpressionAttributeValues: { ":p": projectPK(projectId), ":s": prefix },
				Limit: opts.limit,
				ExclusiveStartKey: decodeCursor(opts.cursor),
			}),
		);
		return {
			keys: ((res.Items as Item[] | undefined) ?? []).map(toKey),
			nextCursor: encodeCursor(
				res.LastEvaluatedKey as Record<string, unknown> | undefined,
			),
		};
	}

	async deleteKey(
		projectId: string,
		namespace: string,
		name: string,
	): Promise<void> {
		await this.deleteItem(projectPK(projectId), keySK(namespace, name));
	}

	/**
	 * Delete one or more keys in a namespace together with all of their
	 * translations across every locale, batched into 25-item BatchWrite chunks.
	 * Each key's translations are read in parallel (one GSI3 query per key) and
	 * all deletes are issued as batched writes — used by importKeys(prune) and
	 * deleteKey so neither walks per-translation single deletes.
	 */
	async deleteKeysCascade(
		projectId: string,
		namespace: string,
		names: string[],
	): Promise<void> {
		const translationLists = await Promise.all(
			names.map((name) =>
				this.listTranslationsByKey(projectId, namespace, name),
			),
		);
		const toDelete: { PK: string; SK: string }[] = [];
		for (let i = 0; i < names.length; i++) {
			const name = names[i]!;
			for (const t of translationLists[i]!) {
				toDelete.push({
					PK: transPK(projectId, t.localeCode),
					SK: keySK(namespace, name),
				});
			}
			toDelete.push({ PK: projectPK(projectId), SK: keySK(namespace, name) });
		}
		await this.batchDelete(toDelete);
	}

	// ---- glossary -------------------------------------------------------------

	async putGlossaryTerm(term: GlossaryTerm): Promise<GlossaryTerm> {
		await this.putItem({
			PK: projectPK(term.projectId),
			SK: glossarySK(term.id),
			entityType: "GlossaryTerm",
			...term,
		});
		return term;
	}

	async getGlossaryTerm(
		projectId: string,
		termId: string,
	): Promise<GlossaryTerm | undefined> {
		return this.getItem(
			projectPK(projectId),
			glossarySK(termId),
			toGlossaryTerm,
		);
	}

	async listGlossary(projectId: string): Promise<GlossaryTerm[]> {
		return this.listByPrefix(projectPK(projectId), "GLOSSARY#", toGlossaryTerm);
	}

	async deleteGlossaryTerm(projectId: string, termId: string): Promise<void> {
		await this.deleteItem(projectPK(projectId), glossarySK(termId));
	}

	// ---- webhooks -------------------------------------------------------------

	async putWebhook(webhook: Webhook): Promise<Webhook> {
		await this.putItem({
			PK: projectPK(webhook.projectId),
			SK: webhookSK(webhook.id),
			entityType: "Webhook",
			...webhook,
		});
		return webhook;
	}

	async getWebhook(
		projectId: string,
		id: string,
	): Promise<Webhook | undefined> {
		return this.getItem(projectPK(projectId), webhookSK(id), toWebhook);
	}

	async listWebhooks(projectId: string): Promise<Webhook[]> {
		return this.listByPrefix(projectPK(projectId), "WEBHOOK#", toWebhook);
	}

	async deleteWebhook(projectId: string, id: string): Promise<void> {
		await this.deleteItem(projectPK(projectId), webhookSK(id));
	}

	// ---- QA config (per-project singleton) ------------------------------------

	async getQaConfig(projectId: string): Promise<QaConfig | undefined> {
		return this.getItem(projectPK(projectId), qaConfigSK(), toQaConfig);
	}

	async putQaConfig(config: QaConfig): Promise<QaConfig> {
		await this.putItem({
			PK: projectPK(config.projectId),
			SK: qaConfigSK(),
			entityType: "QaConfig",
			...config,
		});
		return config;
	}

	// ---- AI-scoring config (per-project singleton) ----------------------------

	async getScoreConfig(projectId: string): Promise<ScoreConfig | undefined> {
		return this.getItem(projectPK(projectId), scoreConfigSK(), toScoreConfig);
	}

	async putScoreConfig(config: ScoreConfig): Promise<ScoreConfig> {
		await this.putItem({
			PK: projectPK(config.projectId),
			SK: scoreConfigSK(),
			entityType: "ScoreConfig",
			...config,
		});
		return config;
	}

	/**
	 * Delete a project and every item beneath it: the project record plus its
	 * locales, keys, members, glossary terms and webhooks (all in the PROJECT#
	 * partition), and the translations stored in each PROJ#<id>#LOC#<code> partition.
	 */
	async deleteProjectCascade(
		projectId: string,
		localeCodes: string[],
	): Promise<void> {
		const toDelete: { PK: string; SK: string }[] = [];
		const partition = await this.queryAll({
			TableName: this.table,
			KeyConditionExpression: "PK = :p",
			ExpressionAttributeValues: { ":p": projectPK(projectId) },
		});
		for (const item of partition) toDelete.push({ PK: item.PK, SK: item.SK });
		for (const code of localeCodes) {
			const translations = await this.queryAll({
				TableName: this.table,
				KeyConditionExpression: "PK = :p",
				ExpressionAttributeValues: { ":p": transPK(projectId, code) },
			});
			for (const item of translations)
				toDelete.push({ PK: item.PK, SK: item.SK });
		}
		await this.batchDelete(toDelete);
	}

	// ---- translations ---------------------------------------------------------

	async putTranslation(t: Translation): Promise<Translation> {
		await this.putItem(translationItem(t));
		return t;
	}

	/** Write many translations efficiently (25 per batch). */
	async putTranslations(list: Translation[]): Promise<void> {
		for (let i = 0; i < list.length; i += 25) {
			const chunk = list.slice(i, i + 25);
			await this.doc.send(
				new BatchWriteCommand({
					RequestItems: {
						[this.table]: chunk.map((t) => ({
							PutRequest: { Item: translationItem(t) },
						})),
					},
				}),
			);
		}
	}

	async getTranslation(
		projectId: string,
		code: string,
		namespace: string,
		name: string,
	): Promise<Translation | undefined> {
		return this.getItem(
			transPK(projectId, code),
			keySK(namespace, name),
			toTranslation,
		);
	}

	/** Every translation for one locale — the export/build query. */
	async listTranslationsByLocale(
		projectId: string,
		code: string,
	): Promise<Translation[]> {
		return this.listByPrefix(transPK(projectId, code), "KEY#", toTranslation);
	}

	/**
	 * One page of a locale's translations. `cursor` is the opaque token returned as
	 * `nextCursor` from a previous page; omit it for the first page. Mirrors
	 * `listKeysPage` so list and export surfaces can bound per-request work.
	 */
	async listTranslationsByLocalePage(
		projectId: string,
		code: string,
		opts: { limit?: number; cursor?: string } = {},
	): Promise<{ translations: Translation[]; nextCursor?: string }> {
		const res = await this.doc.send(
			new QueryCommand({
				TableName: this.table,
				KeyConditionExpression: "PK = :p AND begins_with(SK, :s)",
				ExpressionAttributeValues: {
					":p": transPK(projectId, code),
					":s": "KEY#",
				},
				Limit: opts.limit,
				ExclusiveStartKey: decodeCursor(opts.cursor),
			}),
		);
		return {
			translations: ((res.Items as Item[] | undefined) ?? []).map(
				toTranslation,
			),
			nextCursor: encodeCursor(
				res.LastEvaluatedKey as Record<string, unknown> | undefined,
			),
		};
	}

	/** Every locale's value for one key. */
	async listTranslationsByKey(
		projectId: string,
		namespace: string,
		name: string,
	): Promise<Translation[]> {
		const items = await this.queryAll({
			TableName: this.table,
			IndexName: "GSI3",
			KeyConditionExpression: "GSI3PK = :p",
			ExpressionAttributeValues: {
				":p": keyGSI3PK(projectId, namespace, name),
			},
		});
		return items.map(toTranslation);
	}

	async deleteTranslation(
		projectId: string,
		code: string,
		namespace: string,
		name: string,
	): Promise<void> {
		await this.deleteItem(transPK(projectId, code), keySK(namespace, name));
	}

	// ---- internals ------------------------------------------------------------

	/** Get a single item by primary key and map it to its domain shape. */
	private async getItem<T>(
		pk: string,
		sk: string,
		map: (i: Item) => T,
	): Promise<T | undefined> {
		const res = await this.doc.send(
			new GetCommand({ TableName: this.table, Key: { PK: pk, SK: sk } }),
		);
		return res.Item ? map(res.Item as Item) : undefined;
	}

	/**
	 * Query every item in a partition whose sort key begins with `prefix`,
	 * following pagination, and map each to its domain shape. Pass an `index` to
	 * query a GSI (its `<index>PK`/`<index>SK` attributes) instead of the base table.
	 */
	private async listByPrefix<T>(
		partition: string,
		prefix: string,
		map: (i: Item) => T,
		index?: IndexName,
	): Promise<T[]> {
		const pk = index ? `${index}PK` : "PK";
		const sk = index ? `${index}SK` : "SK";
		const items = await this.queryAll({
			TableName: this.table,
			...(index ? { IndexName: index } : {}),
			KeyConditionExpression: `${pk} = :p AND begins_with(${sk}, :s)`,
			ExpressionAttributeValues: { ":p": partition, ":s": prefix },
		});
		return items.map(map);
	}

	/** Put a fully-formed item, optionally guarded by a condition expression. */
	private async putItem(item: Item, condition?: string): Promise<void> {
		await this.doc.send(
			new PutCommand({
				TableName: this.table,
				Item: item,
				...(condition ? { ConditionExpression: condition } : {}),
			}),
		);
	}

	/** Delete a single item by primary key. */
	private async deleteItem(pk: string, sk: string): Promise<void> {
		await this.doc.send(
			new DeleteCommand({ TableName: this.table, Key: { PK: pk, SK: sk } }),
		);
	}

	/** Delete many items by primary key, batched into 25-item BatchWrite chunks. */
	private async batchDelete(keys: { PK: string; SK: string }[]): Promise<void> {
		for (let i = 0; i < keys.length; i += 25) {
			const chunk = keys.slice(i, i + 25);
			await this.doc.send(
				new BatchWriteCommand({
					RequestItems: {
						[this.table]: chunk.map((Key) => ({ DeleteRequest: { Key } })),
					},
				}),
			);
		}
	}

	/** Run a query to completion, following pagination. */
	private async queryAll(input: QueryCommandInput): Promise<Item[]> {
		const out: Item[] = [];
		let cursor: Record<string, unknown> | undefined;
		do {
			const res = await this.doc.send(
				new QueryCommand({ ...input, ExclusiveStartKey: cursor }),
			);
			out.push(...((res.Items as Item[] | undefined) ?? []));
			cursor = res.LastEvaluatedKey as Record<string, unknown> | undefined;
		} while (cursor);
		return out;
	}
}

/**
 * The public method surface of {@link Repository}. Services and auth helpers
 * depend on this interface rather than the concrete class, so a complete
 * in-memory fake can stand in without a cast and the compiler enforces that the
 * fake implements every method. `keyof` excludes the private `doc`/`table`
 * fields, leaving only the public API.
 */
export type RepositoryApi = Pick<Repository, keyof Repository>;
