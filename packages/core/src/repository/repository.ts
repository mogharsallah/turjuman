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
	Branch,
	Comment,
	ContextRule,
	Escalation,
	Example,
	FieldReport,
	GlobalRole,
	GlossaryTerm,
	Locale,
	Membership,
	Namespace,
	Project,
	QaConfig,
	Release,
	Translation,
	TranslationKey,
	TranslationRun,
	TranslationVersion,
	User,
	Webhook,
} from "@turjuman/schema";
import { conflict, MAIN_BRANCH_ID } from "@turjuman/schema";
import { decodeCursor, encodeCursor } from "./cursor.js";
import type { IndexName, Item } from "./item.js";
import {
	apiKeyPK,
	branchSK,
	cellGSI3PK,
	cellPK,
	cellSK,
	commentPrefix,
	commentSK,
	contextRuleSK,
	emailPK,
	escalationSK,
	exampleSK,
	fieldReportSK,
	glossarySK,
	keyDefPK,
	keyDefSK,
	keyNameSK,
	localeSK,
	memberSK,
	namespaceSK,
	orgGSI1PK,
	orgOwnerPK,
	projectPK,
	qaConfigSK,
	releaseEntryPK,
	releaseSK,
	runSK,
	userPK,
	versionPrefix,
	versionSK,
	webhookSK,
} from "./keys.js";
import {
	cellItem,
	isConditionalFailure,
	keyDefItem,
	keyNameItem,
	releaseEntryItem,
	toApiKey,
	toBranch,
	toCell,
	toComment,
	toContextRule,
	toEscalation,
	toExample,
	toFieldReport,
	toGlossaryTerm,
	toKey,
	toLocale,
	toMembership,
	toNamespace,
	toProject,
	toQaConfig,
	toRelease,
	toReleaseEntry,
	toRun,
	toUser,
	toVersion,
	toWebhook,
	versionItem,
} from "./mappers.js";

/**
 * Single-table DynamoDB repository.
 *
 * Key design (see `docs/concepts/architecture.mdx`). All GSIs project ALL
 * attributes.
 *   GSI1 — "by org": list projects/users in an org.
 *   GSI2 — "by user": memberships and API keys belonging to a user.
 *   GSI3 — "by key":  every locale's live cell for one key on one branch.
 *
 * Identity is opaque. A key is addressed by `keyId`; a translation by the cell
 * `(branchId, keyId, locale)`. `(namespace, name)` are renamable labels kept in a
 * side `KEYNAME# -> keyId` lookup row, written in the same transaction as the key
 * so uniqueness is race-safe and a rename never moves translation data.
 *
 * Branches are copy-on-write: a key/cell exists only on the branch that wrote it;
 * an unwritten row resolves by **falling through** to the parent branch
 * ({@link getWithFallthrough}). On `main` (`parentBranchId = null`) the chain has
 * one link, so a read is a single point-get.
 *
 * Almost every method is a thin wrapper over the private primitives — getItem,
 * listByPrefix, putItem, deleteItem/batchDelete, queryAll. The bespoke ones (the
 * uniqueness transactions, the accept compare-and-swap, the paged queries) keep
 * their own command bodies. PK/SK builders live in ./keys.ts, Item<->domain
 * mappers in ./mappers.ts.
 */

export interface RepositoryOptions {
	tableName: string;
	/** Optional override (used for dynamodb-local in tests). */
	client?: DynamoDBClient;
}

/** Inputs to {@link Repository.acceptCell}: the value to commit plus attribution. */
export interface AcceptCellParams {
	projectId: string;
	branchId: string;
	keyId: string;
	locale: string;
	value: string;
	origin?: Translation["origin"];
	/** The base revision this value was accepted against (clears staleness). */
	sourceRevision?: string;
	/** Human who accepted (mutually exclusive with `runRef`). */
	acceptedBy?: string;
	/** Run that accepted (mutually exclusive with `acceptedBy`). */
	runRef?: string;
	/** The cell's current `head` (the optimistic-concurrency guard); omit for the
	 * first accept (the cell must then have no `head`). */
	expectedHead?: number;
	updatedBy: string;
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
	 * guarded by `attribute_not_exists(PK)`. The sentinel makes the single-owner
	 * invariant race-safe: two concurrent first-owner requests (e.g. against the
	 * unauthenticated `POST /v1/bootstrap`) can't both win — the loser's
	 * conditional check fails and the whole transaction rolls back. Bundling the
	 * key removes the half-state where an owner exists with no key.
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
		patch: Partial<
			Pick<
				Project,
				| "name"
				| "description"
				| "baseLocale"
				| "contextRevision"
				| "requireHumanAccept"
			>
		>,
	): Promise<void> {
		const sets: string[] = ["updatedAt = :t"];
		const values: Record<string, unknown> = { ":t": new Date().toISOString() };
		if (patch.name !== undefined)
			sets.push("#n = :n"), (values[":n"] = patch.name);
		if (patch.description !== undefined)
			sets.push("description = :d"), (values[":d"] = patch.description);
		if (patch.baseLocale !== undefined)
			sets.push("baseLocale = :b"), (values[":b"] = patch.baseLocale);
		if (patch.contextRevision !== undefined)
			sets.push("contextRevision = :cr"),
				(values[":cr"] = patch.contextRevision);
		if (patch.requireHumanAccept !== undefined)
			sets.push("requireHumanAccept = :rh"),
				(values[":rh"] = patch.requireHumanAccept);
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

	// ---- branches -------------------------------------------------------------

	async putBranch(branch: Branch): Promise<Branch> {
		await this.putItem({
			PK: projectPK(branch.projectId),
			SK: branchSK(branch.id),
			entityType: "Branch",
			...branch,
		});
		return branch;
	}

	async getBranch(
		projectId: string,
		branchId: string,
	): Promise<Branch | undefined> {
		return this.getItem(projectPK(projectId), branchSK(branchId), toBranch);
	}

	async listBranches(projectId: string): Promise<Branch[]> {
		return this.listByPrefix(projectPK(projectId), "BRANCH#", toBranch);
	}

	// ---- namespaces -----------------------------------------------------------

	async putNamespace(ns: Namespace): Promise<Namespace> {
		await this.putItem({
			PK: projectPK(ns.projectId),
			SK: namespaceSK(ns.id),
			entityType: "Namespace",
			...ns,
		});
		return ns;
	}

	async getNamespace(
		projectId: string,
		namespaceId: string,
	): Promise<Namespace | undefined> {
		return this.getItem(
			projectPK(projectId),
			namespaceSK(namespaceId),
			toNamespace,
		);
	}

	async listNamespaces(projectId: string): Promise<Namespace[]> {
		return this.listByPrefix(projectPK(projectId), "NS#", toNamespace);
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

	// ---- key definitions ------------------------------------------------------

	/**
	 * Create a key definition together with its `(namespace, name) -> keyId`
	 * lookup row, in one transaction guarded by `attribute_not_exists` on both —
	 * so a duplicate name (in the same namespace, on the same branch) can't slip
	 * through under concurrency. Throws CONFLICT on a dup name.
	 */
	async createKeyDef(
		branchId: string,
		key: TranslationKey,
	): Promise<TranslationKey> {
		try {
			await this.doc.send(
				new TransactWriteCommand({
					TransactItems: [
						{
							Put: {
								TableName: this.table,
								Item: keyDefItem(branchId, key),
								ConditionExpression: "attribute_not_exists(SK)",
							},
						},
						{
							Put: {
								TableName: this.table,
								Item: keyNameItem(branchId, key),
								ConditionExpression: "attribute_not_exists(SK)",
							},
						},
					],
				}),
			);
		} catch (err) {
			if (isConditionalFailure(err))
				throw conflict(`Key "${key.name}" already exists`);
			throw err;
		}
		return key;
	}

	/** Overwrite a key definition in place (metadata / state / lastSeenAt). The
	 * name is unchanged, so the lookup row is left as-is; use {@link renameKeyDef}
	 * to move a key to a new `(namespace, name)`. */
	async putKeyDef(
		branchId: string,
		key: TranslationKey,
	): Promise<TranslationKey> {
		await this.putItem(keyDefItem(branchId, key));
		return key;
	}

	/**
	 * Move a key to a new `(namespace, name)`: write the new lookup row
	 * (`attribute_not_exists` so a taken name conflicts), tombstone the old one,
	 * and overwrite the key definition — all in one transaction. `key` already
	 * carries the new label; `from` is the prior `(namespaceId, name)`.
	 */
	async renameKeyDef(
		branchId: string,
		key: TranslationKey,
		from: { namespaceId?: string; name: string },
	): Promise<TranslationKey> {
		try {
			await this.doc.send(
				new TransactWriteCommand({
					TransactItems: [
						{
							Put: {
								TableName: this.table,
								Item: keyNameItem(branchId, key),
								ConditionExpression: "attribute_not_exists(SK)",
							},
						},
						{
							Delete: {
								TableName: this.table,
								Key: {
									PK: keyDefPK(key.projectId, branchId),
									SK: keyNameSK(from.namespaceId, from.name),
								},
							},
						},
						{
							Put: { TableName: this.table, Item: keyDefItem(branchId, key) },
						},
					],
				}),
			);
		} catch (err) {
			if (isConditionalFailure(err))
				throw conflict(`Key "${key.name}" already exists`);
			throw err;
		}
		return key;
	}

	/** A key definition by id, resolved through the branch's parent chain. */
	async getKeyDef(
		projectId: string,
		branchId: string,
		keyId: string,
	): Promise<TranslationKey | undefined> {
		return this.getWithFallthrough(
			projectId,
			branchId,
			(br) => keyDefPK(projectId, br),
			keyDefSK(keyId),
			toKey,
		);
	}

	/** Resolve `(namespace, name)` to its `keyId` through the branch's parent
	 * chain, or `undefined` if no live key holds that name. */
	async resolveKeyIdByName(
		projectId: string,
		branchId: string,
		namespaceId: string | undefined,
		name: string,
	): Promise<string | undefined> {
		return this.getWithFallthrough(
			projectId,
			branchId,
			(br) => keyDefPK(projectId, br),
			keyNameSK(namespaceId, name),
			(i) => i.keyId as string,
		);
	}

	/** Every key definition written on this branch (no parent overlay in B1). */
	async listKeyDefs(
		projectId: string,
		branchId: string,
	): Promise<TranslationKey[]> {
		return this.listByPrefix(keyDefPK(projectId, branchId), "KEY#", toKey);
	}

	/** One page of this branch's key definitions. `cursor` is the opaque token
	 * returned as `nextCursor`; omit it for the first page. */
	async listKeyDefsPage(
		projectId: string,
		branchId: string,
		opts: { limit?: number; cursor?: string } = {},
	): Promise<{ keys: TranslationKey[]; nextCursor?: string }> {
		const res = await this.doc.send(
			new QueryCommand({
				TableName: this.table,
				KeyConditionExpression: "PK = :p AND begins_with(SK, :s)",
				ExpressionAttributeValues: {
					":p": keyDefPK(projectId, branchId),
					":s": "KEY#",
				},
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

	/**
	 * Every key definition **visible** on a branch: its own rows overlaid on the
	 * parent chain, the nearest branch winning per `keyId` (the copy-on-write
	 * overlay). On `main` this is exactly {@link listKeyDefs}; on a child branch it
	 * unions in the parent's keys the branch never touched. Used to materialize a
	 * release's full resolved view.
	 */
	async listKeyDefsResolved(
		projectId: string,
		branchId: string,
	): Promise<TranslationKey[]> {
		const chain = await this.branchChain(projectId, branchId);
		const byId = new Map<string, TranslationKey>();
		for (const br of chain)
			for (const k of await this.listKeyDefs(projectId, br))
				if (!byId.has(k.id)) byId.set(k.id, k); // nearest branch wins
		return [...byId.values()];
	}

	/**
	 * Hard-delete keys and everything beneath them on one branch: each key's
	 * definition row, its `KEYNAME#` lookup row, and every locale's live cell plus
	 * the cell's append-only version chain. Batched into 25-item BatchWrite chunks.
	 */
	async deleteKeyDefsCascade(
		projectId: string,
		branchId: string,
		keys: Pick<TranslationKey, "id" | "namespaceId" | "name">[],
	): Promise<void> {
		const toDelete: { PK: string; SK: string }[] = [];
		for (const key of keys) {
			toDelete.push({
				PK: keyDefPK(projectId, branchId),
				SK: keyDefSK(key.id),
			});
			toDelete.push({
				PK: keyDefPK(projectId, branchId),
				SK: keyNameSK(key.namespaceId, key.name),
			});
			for (const k of await this.cellRowKeys(projectId, branchId, key.id))
				toDelete.push(k);
		}
		await this.batchDelete(toDelete);
	}

	// ---- translation cells ----------------------------------------------------

	async putCell(cell: Translation): Promise<Translation> {
		await this.putItem(cellItem(cell));
		return cell;
	}

	/** Write many live cells efficiently (25 per batch). */
	async putCells(list: Translation[]): Promise<void> {
		for (let i = 0; i < list.length; i += 25) {
			const chunk = list.slice(i, i + 25);
			await this.doc.send(
				new BatchWriteCommand({
					RequestItems: {
						[this.table]: chunk.map((c) => ({
							PutRequest: { Item: cellItem(c) },
						})),
					},
				}),
			);
		}
	}

	/** The live cell for `(branchId, keyId, locale)`, resolved through the branch
	 * parent chain. */
	async getCell(
		projectId: string,
		branchId: string,
		keyId: string,
		locale: string,
	): Promise<Translation | undefined> {
		return this.getWithFallthrough(
			projectId,
			branchId,
			(br) => cellPK(projectId, br, locale),
			cellSK(keyId),
			toCell,
		);
	}

	/** Every live cell in one branch×locale (the export/build query). Excludes the
	 * version rows, which share the partition under the `VER#` prefix. */
	async listCellsByLocale(
		projectId: string,
		branchId: string,
		locale: string,
	): Promise<Translation[]> {
		return this.listByPrefix(
			cellPK(projectId, branchId, locale),
			"KEY#",
			toCell,
		);
	}

	/** One page of a branch×locale's live cells. `cursor` is the opaque token
	 * returned as `nextCursor`; omit it for the first page. */
	async listCellsByLocalePage(
		projectId: string,
		branchId: string,
		locale: string,
		opts: { limit?: number; cursor?: string } = {},
	): Promise<{ cells: Translation[]; nextCursor?: string }> {
		const res = await this.doc.send(
			new QueryCommand({
				TableName: this.table,
				KeyConditionExpression: "PK = :p AND begins_with(SK, :s)",
				ExpressionAttributeValues: {
					":p": cellPK(projectId, branchId, locale),
					":s": "KEY#",
				},
				Limit: opts.limit,
				ExclusiveStartKey: decodeCursor(opts.cursor),
			}),
		);
		return {
			cells: ((res.Items as Item[] | undefined) ?? []).map(toCell),
			nextCursor: encodeCursor(
				res.LastEvaluatedKey as Record<string, unknown> | undefined,
			),
		};
	}

	/** Every locale's live cell for one key on one branch (the `get_key` join). */
	async listCellsByKey(
		projectId: string,
		branchId: string,
		keyId: string,
	): Promise<Translation[]> {
		const items = await this.queryAll({
			TableName: this.table,
			IndexName: "GSI3",
			KeyConditionExpression: "GSI3PK = :p",
			ExpressionAttributeValues: {
				":p": cellGSI3PK(projectId, branchId, keyId),
			},
		});
		return items.map(toCell);
	}

	async deleteCell(
		projectId: string,
		branchId: string,
		keyId: string,
		locale: string,
	): Promise<void> {
		await this.deleteItem(cellPK(projectId, branchId, locale), cellSK(keyId));
	}

	/**
	 * Accept a value: append a new version (`seq = head + 1`) and advance the
	 * cell's `head` to it, in one transaction. The version Put is guarded by
	 * `attribute_not_exists(SK)` and the cell Update by a compare-and-swap on
	 * `head` (`attribute_not_exists(head)` for the first accept) — so two accepts
	 * racing off the same `head` can't both win; the loser gets CONFLICT and
	 * re-loops against the winner's value. Attribution is `runRef` (a run) **or**
	 * `acceptedBy` (a human), per the project's accept policy.
	 */
	async acceptCell(params: AcceptCellParams): Promise<Translation> {
		const now = new Date().toISOString();
		const seq = (params.expectedHead ?? 0) + 1;
		const version: TranslationVersion = {
			projectId: params.projectId,
			branchId: params.branchId,
			keyId: params.keyId,
			locale: params.locale,
			seq,
			value: params.value,
			origin: params.origin,
			acceptedAt: now,
			acceptedBy: params.acceptedBy,
			runRef: params.runRef,
			sourceRevision: params.sourceRevision,
			prevVersionRef: params.expectedHead,
		};

		const sets = [
			"#head = :seq",
			"#value = :val",
			"#lifecycle = :lc",
			"#stale = :st",
			"#updatedBy = :ub",
			"#updatedAt = :t",
		];
		const names: Record<string, string> = {
			"#head": "head",
			"#value": "value",
			"#lifecycle": "lifecycle",
			"#stale": "stale",
			"#updatedBy": "updatedBy",
			"#updatedAt": "updatedAt",
			"#lock": "lockedByRunId",
		};
		const values: Record<string, unknown> = {
			":seq": seq,
			":val": params.value,
			":lc": "accepted",
			":st": false,
			":ub": params.updatedBy,
			":t": now,
		};
		if (params.sourceRevision !== undefined) {
			sets.push("#sourceRef = :sr");
			names["#sourceRef"] = "sourceRef";
			values[":sr"] = params.sourceRevision;
		}
		if (params.origin !== undefined) {
			sets.push("#origin = :o");
			names["#origin"] = "origin";
			values[":o"] = params.origin;
		}
		let condition: string;
		if (params.expectedHead === undefined) {
			condition = "attribute_exists(PK) AND attribute_not_exists(#head)";
		} else {
			condition = "#head = :expected";
			values[":expected"] = params.expectedHead;
		}

		try {
			await this.doc.send(
				new TransactWriteCommand({
					TransactItems: [
						{
							Put: {
								TableName: this.table,
								Item: versionItem(version),
								ConditionExpression: "attribute_not_exists(SK)",
							},
						},
						{
							Update: {
								TableName: this.table,
								Key: {
									PK: cellPK(params.projectId, params.branchId, params.locale),
									SK: cellSK(params.keyId),
								},
								UpdateExpression: `SET ${sets.join(", ")} REMOVE #lock`,
								ExpressionAttributeNames: names,
								ExpressionAttributeValues: values,
								ConditionExpression: condition,
							},
						},
					],
				}),
			);
		} catch (err) {
			if (isConditionalFailure(err))
				throw conflict(
					"Translation changed while accepting; reload and retry the accept.",
				);
			throw err;
		}

		return {
			projectId: params.projectId,
			branchId: params.branchId,
			keyId: params.keyId,
			locale: params.locale,
			value: params.value,
			head: seq,
			lifecycle: "accepted",
			stale: false,
			sourceRef: params.sourceRevision,
			origin: params.origin,
			updatedBy: params.updatedBy,
			updatedAt: now,
		};
	}

	/** A single accepted version by seq (used to ship the head value on export). */
	async getVersion(
		projectId: string,
		branchId: string,
		keyId: string,
		locale: string,
		seq: number,
	): Promise<TranslationVersion | undefined> {
		return this.getItem(
			cellPK(projectId, branchId, locale),
			versionSK(keyId, seq),
			toVersion,
		);
	}

	/** The full version chain for one cell, in seq order (history view). */
	async getCellHistory(
		projectId: string,
		branchId: string,
		keyId: string,
		locale: string,
	): Promise<TranslationVersion[]> {
		return this.listByPrefix(
			cellPK(projectId, branchId, locale),
			versionPrefix(keyId),
			toVersion,
		);
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

	// ---- context rules --------------------------------------------------------

	async putContextRule(rule: ContextRule): Promise<ContextRule> {
		await this.putItem({
			PK: projectPK(rule.projectId),
			SK: contextRuleSK(rule.id),
			entityType: "ContextRule",
			...rule,
		});
		return rule;
	}

	async getContextRule(
		projectId: string,
		id: string,
	): Promise<ContextRule | undefined> {
		return this.getItem(projectPK(projectId), contextRuleSK(id), toContextRule);
	}

	async listContextRules(projectId: string): Promise<ContextRule[]> {
		return this.listByPrefix(projectPK(projectId), "CTXRULE#", toContextRule);
	}

	async deleteContextRule(projectId: string, id: string): Promise<void> {
		await this.deleteItem(projectPK(projectId), contextRuleSK(id));
	}

	// ---- examples (the few-shot / translation-memory corpus) ------------------

	async putExample(example: Example): Promise<Example> {
		await this.putItem({
			PK: projectPK(example.projectId),
			SK: exampleSK(example.id),
			entityType: "Example",
			...example,
		});
		return example;
	}

	async getExample(
		projectId: string,
		id: string,
	): Promise<Example | undefined> {
		return this.getItem(projectPK(projectId), exampleSK(id), toExample);
	}

	async listExamples(projectId: string): Promise<Example[]> {
		return this.listByPrefix(projectPK(projectId), "EXAMPLE#", toExample);
	}

	async deleteExample(projectId: string, id: string): Promise<void> {
		await this.deleteItem(projectPK(projectId), exampleSK(id));
	}

	// ---- comments (branch-free, per (key, locale) string) ---------------------

	async putComment(comment: Comment): Promise<Comment> {
		await this.putItem({
			PK: projectPK(comment.projectId),
			SK: commentSK(comment.keyId, comment.locale, comment.id),
			entityType: "Comment",
			...comment,
		});
		return comment;
	}

	async listComments(
		projectId: string,
		keyId: string,
		locale: string,
	): Promise<Comment[]> {
		return this.listByPrefix(
			projectPK(projectId),
			commentPrefix(keyId, locale),
			toComment,
		);
	}

	async deleteComment(
		projectId: string,
		keyId: string,
		locale: string,
		id: string,
	): Promise<void> {
		await this.deleteItem(projectPK(projectId), commentSK(keyId, locale, id));
	}

	// ---- escalations (the review router's human exit) -------------------------

	async putEscalation(escalation: Escalation): Promise<Escalation> {
		await this.putItem({
			PK: projectPK(escalation.projectId),
			SK: escalationSK(escalation.id),
			entityType: "Escalation",
			...escalation,
		});
		return escalation;
	}

	async getEscalation(
		projectId: string,
		id: string,
	): Promise<Escalation | undefined> {
		return this.getItem(projectPK(projectId), escalationSK(id), toEscalation);
	}

	async listEscalations(projectId: string): Promise<Escalation[]> {
		return this.listByPrefix(projectPK(projectId), "ESC#", toEscalation);
	}

	/**
	 * Claim an open, unclaimed escalation — a compare-and-swap on `claimedBy`, so
	 * two reviewers racing for the same one can't both win. Throws CONFLICT if it
	 * was already claimed or resolved.
	 */
	async claimEscalation(
		projectId: string,
		id: string,
		userId: string,
		at: string,
	): Promise<Escalation> {
		try {
			await this.doc.send(
				new UpdateCommand({
					TableName: this.table,
					Key: { PK: projectPK(projectId), SK: escalationSK(id) },
					UpdateExpression: "SET claimedBy = :u, claimedAt = :t",
					ConditionExpression:
						"attribute_exists(PK) AND attribute_not_exists(claimedBy) AND #s = :open",
					ExpressionAttributeNames: { "#s": "status" },
					ExpressionAttributeValues: {
						":u": userId,
						":t": at,
						":open": "open",
					},
				}),
			);
		} catch (err) {
			if (isConditionalFailure(err))
				throw conflict("Escalation already claimed or resolved");
			throw err;
		}
		const updated = await this.getEscalation(projectId, id);
		if (!updated) throw conflict(`Escalation ${id} not found`);
		return updated;
	}

	// ---- context staleness fan-out --------------------------------------------

	/** Atomically increment the project's context revision; returns the new value.
	 * Bumped on any scoped context write (drives context-staleness). */
	async bumpContextRevision(projectId: string): Promise<number> {
		const res = await this.doc.send(
			new UpdateCommand({
				TableName: this.table,
				Key: { PK: projectPK(projectId), SK: projectPK(projectId) },
				UpdateExpression:
					"SET contextRevision = if_not_exists(contextRevision, :z) + :one, updatedAt = :t",
				ConditionExpression: "attribute_exists(PK)",
				ExpressionAttributeValues: {
					":z": 0,
					":one": 1,
					":t": new Date().toISOString(),
				},
				ReturnValues: "UPDATED_NEW",
			}),
		);
		return (res.Attributes?.contextRevision as number | undefined) ?? 0;
	}

	/**
	 * Mark every live, translated cell of one key (all locales on one branch)
	 * `stale = true` — the context-change fan-out. Dependents re-enter the router
	 * and are re-translated inside a budgeted run. Returns the count touched.
	 */
	async markCellsStaleByKey(
		projectId: string,
		branchId: string,
		keyId: string,
	): Promise<number> {
		const cells = await this.listCellsByKey(projectId, branchId, keyId);
		const touched = cells
			.filter(
				(c) =>
					!c.stale &&
					c.lifecycle !== "untranslated" &&
					c.lifecycle !== "retired",
			)
			.map((c) => ({ ...c, stale: true }));
		await this.putCells(touched);
		return touched.length;
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

	// ---- runs (the agent write primitive) -------------------------------------

	async putRun(run: TranslationRun): Promise<TranslationRun> {
		await this.putItem({
			PK: projectPK(run.projectId),
			SK: runSK(run.id),
			entityType: "TranslationRun",
			...run,
		});
		return run;
	}

	async getRun(
		projectId: string,
		runId: string,
	): Promise<TranslationRun | undefined> {
		return this.getItem(projectPK(projectId), runSK(runId), toRun);
	}

	async listRunsByBranch(
		projectId: string,
		branchId: string,
	): Promise<TranslationRun[]> {
		const runs = await this.listByPrefix(projectPK(projectId), "RUN#", toRun);
		return runs.filter((r) => r.branchId === branchId);
	}

	// ---- releases (immutable shipped snapshots) -------------------------------

	/**
	 * Write a release: its metadata row in the project partition (so releases list
	 * with one prefix query) plus one entry row per pinned cell in the release's
	 * own partition (batched 25 at a time), so a big release never bloats a single
	 * item. Entries are immutable once written.
	 */
	async putRelease(release: Release): Promise<Release> {
		const { entries, ...meta } = release;
		await this.putItem({
			PK: projectPK(release.projectId),
			SK: releaseSK(release.id),
			entityType: "Release",
			...meta,
		});
		const rows = entries.map((e) =>
			releaseEntryItem(release.projectId, release.id, e),
		);
		for (let i = 0; i < rows.length; i += 25) {
			const chunk = rows.slice(i, i + 25);
			await this.doc.send(
				new BatchWriteCommand({
					RequestItems: {
						[this.table]: chunk.map((Item) => ({ PutRequest: { Item } })),
					},
				}),
			);
		}
		return release;
	}

	/** A release's metadata plus its pinned entries, reassembled. */
	async getRelease(
		projectId: string,
		releaseId: string,
	): Promise<Release | undefined> {
		const meta = await this.getItem(
			projectPK(projectId),
			releaseSK(releaseId),
			toRelease,
		);
		if (!meta) return undefined;
		const entries = await this.listByPrefix(
			releaseEntryPK(projectId, releaseId),
			"KEY#",
			toReleaseEntry,
		);
		return { ...meta, entries };
	}

	/** Every release in a project, metadata only (entries omitted — use
	 * {@link getRelease} for one release's pinned entries). */
	async listReleases(projectId: string): Promise<Release[]> {
		return this.listByPrefix(projectPK(projectId), "REL#", toRelease);
	}

	/** Flip a release's lifecycle status (e.g. mark a prior release `superseded`
	 * when a newer one is cut). Its pinned entries are immutable and untouched. */
	async setReleaseStatus(
		projectId: string,
		releaseId: string,
		status: Release["status"],
	): Promise<void> {
		await this.doc.send(
			new UpdateCommand({
				TableName: this.table,
				Key: { PK: projectPK(projectId), SK: releaseSK(releaseId) },
				UpdateExpression: "SET #s = :st",
				ExpressionAttributeNames: { "#s": "status" },
				ExpressionAttributeValues: { ":st": status },
				ConditionExpression: "attribute_exists(PK)",
			}),
		);
	}

	// ---- field reports (production feedback) ----------------------------------

	async putFieldReport(report: FieldReport): Promise<FieldReport> {
		await this.putItem({
			PK: projectPK(report.projectId),
			SK: fieldReportSK(report.id),
			entityType: "FieldReport",
			...report,
		});
		return report;
	}

	async getFieldReport(
		projectId: string,
		id: string,
	): Promise<FieldReport | undefined> {
		return this.getItem(projectPK(projectId), fieldReportSK(id), toFieldReport);
	}

	async listFieldReports(projectId: string): Promise<FieldReport[]> {
		return this.listByPrefix(projectPK(projectId), "FR#", toFieldReport);
	}

	// ---- project cascade ------------------------------------------------------

	/**
	 * Delete a project and every item beneath it: the `PROJECT#<id>` partition
	 * (locales, members, glossary, webhooks, qa-config, branches, namespaces,
	 * runs, context rules, examples, escalations, comments, releases, field
	 * reports), every branch's key-definition partition, every branch×locale
	 * cell/version partition, and every release's entry partition.
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
		const branchIds = new Set<string>([MAIN_BRANCH_ID]);
		const releaseIds = new Set<string>();
		for (const item of partition) {
			toDelete.push({ PK: item.PK, SK: item.SK });
			if (item.entityType === "Branch" && typeof item.id === "string")
				branchIds.add(item.id);
			if (item.entityType === "Release" && typeof item.id === "string")
				releaseIds.add(item.id);
		}
		for (const branchId of branchIds) {
			const defs = await this.queryAll({
				TableName: this.table,
				KeyConditionExpression: "PK = :p",
				ExpressionAttributeValues: { ":p": keyDefPK(projectId, branchId) },
			});
			for (const item of defs) toDelete.push({ PK: item.PK, SK: item.SK });
			for (const code of localeCodes) {
				const cells = await this.queryAll({
					TableName: this.table,
					KeyConditionExpression: "PK = :p",
					ExpressionAttributeValues: {
						":p": cellPK(projectId, branchId, code),
					},
				});
				for (const item of cells) toDelete.push({ PK: item.PK, SK: item.SK });
			}
		}
		for (const releaseId of releaseIds) {
			const rows = await this.queryAll({
				TableName: this.table,
				KeyConditionExpression: "PK = :p",
				ExpressionAttributeValues: {
					":p": releaseEntryPK(projectId, releaseId),
				},
			});
			for (const item of rows) toDelete.push({ PK: item.PK, SK: item.SK });
		}
		await this.batchDelete(toDelete);
	}

	// ---- internals ------------------------------------------------------------

	/** Get a single raw item by primary key (no domain mapping). */
	private async getRaw(pk: string, sk: string): Promise<Item | undefined> {
		const res = await this.doc.send(
			new GetCommand({ TableName: this.table, Key: { PK: pk, SK: sk } }),
		);
		return res.Item as Item | undefined;
	}

	/** Get a single item by primary key and map it to its domain shape. */
	private async getItem<T>(
		pk: string,
		sk: string,
		map: (i: Item) => T,
	): Promise<T | undefined> {
		const item = await this.getRaw(pk, sk);
		return item ? map(item) : undefined;
	}

	/**
	 * Copy-on-write read: try the branch's own partition first, then fall through
	 * to each ancestor up to the root. Returns the first hit mapped to its domain
	 * shape. On `main` (or any branch that wrote the row) this is a single get; the
	 * ancestor walk only runs on a miss against a non-root branch.
	 */
	private async getWithFallthrough<T>(
		projectId: string,
		branchId: string,
		pkFor: (branchId: string) => string,
		sk: string,
		map: (i: Item) => T,
	): Promise<T | undefined> {
		const own = await this.getRaw(pkFor(branchId), sk);
		if (own) return map(own);
		if (branchId === MAIN_BRANCH_ID) return undefined; // root has no parent
		const chain = await this.branchChain(projectId, branchId);
		for (let i = 1; i < chain.length; i++) {
			const hit = await this.getRaw(pkFor(chain[i]!), sk);
			if (hit) return map(hit);
		}
		return undefined;
	}

	/** The branch ids from `branchId` up to the root, self first. */
	private async branchChain(
		projectId: string,
		branchId: string,
	): Promise<string[]> {
		const chain: string[] = [];
		let current: string | null | undefined = branchId;
		while (current) {
			chain.push(current);
			if (current === MAIN_BRANCH_ID) break;
			current = (await this.getBranch(projectId, current))?.parentBranchId;
		}
		return chain;
	}

	/** Every row key (live cell + version chain) for one key across all locales. */
	private async cellRowKeys(
		projectId: string,
		branchId: string,
		keyId: string,
	): Promise<{ PK: string; SK: string }[]> {
		const cells = await this.queryAll({
			TableName: this.table,
			IndexName: "GSI3",
			KeyConditionExpression: "GSI3PK = :p",
			ExpressionAttributeValues: {
				":p": cellGSI3PK(projectId, branchId, keyId),
			},
		});
		const out: { PK: string; SK: string }[] = [];
		for (const cell of cells) {
			out.push({ PK: cell.PK, SK: cell.SK });
			const versions = await this.queryAll({
				TableName: this.table,
				KeyConditionExpression: "PK = :p AND begins_with(SK, :s)",
				ExpressionAttributeValues: {
					":p": cell.PK,
					":s": versionPrefix(keyId),
				},
			});
			for (const v of versions) out.push({ PK: v.PK, SK: v.SK });
		}
		return out;
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
