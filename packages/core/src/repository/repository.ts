import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
	BatchWriteCommand,
	type BatchWriteCommandInput,
	DeleteCommand,
	DynamoDBDocumentClient,
	GetCommand,
	PutCommand,
	QueryCommand,
	type QueryCommandInput,
	TransactWriteCommand,
	type TransactWriteCommandInput,
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
import { conflict, MAIN_BRANCH_ID, validation } from "@turjuman/schema";
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
	namespaceNameSK,
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
	keyDefTombstone,
	keyNameItem,
	keyNameTombstone,
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

/**
 * A copy-on-write read that also reports **which branch** the value resolved
 * from. `branchId === the queried branch` means the branch owns the row; a
 * different id means it was inherited from that ancestor (so a mutation must
 * first {@link Repository.materializeCell copy it down}).
 */
export interface Resolved<T> {
	value: T;
	branchId: string;
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

	/**
	 * Create a namespace together with a companion `NSNAME#<name>` uniqueness guard,
	 * in one transaction guarded by `attribute_not_exists` on both — so two
	 * concurrent creates of the same name can't both win (mirrors the email- and
	 * key-name uniqueness transactions). Throws CONFLICT on a duplicate name.
	 */
	async createNamespace(ns: Namespace): Promise<Namespace> {
		try {
			await this.doc.send(
				new TransactWriteCommand({
					TransactItems: [
						{
							Put: {
								TableName: this.table,
								Item: {
									PK: projectPK(ns.projectId),
									SK: namespaceSK(ns.id),
									entityType: "Namespace",
									...ns,
								} satisfies Item,
								ConditionExpression: "attribute_not_exists(PK)",
							},
						},
						{
							Put: {
								TableName: this.table,
								Item: {
									PK: projectPK(ns.projectId),
									SK: namespaceNameSK(ns.name),
									entityType: "NamespaceName",
									namespaceId: ns.id,
								} satisfies Item,
								ConditionExpression: "attribute_not_exists(PK)",
							},
						},
					],
				}),
			);
		} catch (err) {
			if (isConditionalFailure(err))
				throw conflict(`Namespace "${ns.name}" already exists`);
			throw err;
		}
		return ns;
	}

	/** Overwrite a namespace in place (metadata / lifecycle). The name is unchanged,
	 * so the `NSNAME#` guard is left as-is; use {@link renameNamespace} to change it. */
	async putNamespace(ns: Namespace): Promise<Namespace> {
		await this.putItem({
			PK: projectPK(ns.projectId),
			SK: namespaceSK(ns.id),
			entityType: "Namespace",
			...ns,
		});
		return ns;
	}

	/**
	 * Rename a namespace: claim the new `NSNAME#` guard (`attribute_not_exists`),
	 * free the old one, and overwrite the namespace — all in one transaction, so a
	 * name can never be double-claimed and the guard never drifts from the record.
	 * `ns` already carries the new name; `fromName` is the prior name.
	 */
	async renameNamespace(ns: Namespace, fromName: string): Promise<Namespace> {
		try {
			await this.doc.send(
				new TransactWriteCommand({
					TransactItems: [
						{
							Put: {
								TableName: this.table,
								Item: {
									PK: projectPK(ns.projectId),
									SK: namespaceNameSK(ns.name),
									entityType: "NamespaceName",
									namespaceId: ns.id,
								} satisfies Item,
								ConditionExpression: "attribute_not_exists(PK)",
							},
						},
						{
							Delete: {
								TableName: this.table,
								Key: {
									PK: projectPK(ns.projectId),
									SK: namespaceNameSK(fromName),
								},
							},
						},
						{
							Put: {
								TableName: this.table,
								Item: {
									PK: projectPK(ns.projectId),
									SK: namespaceSK(ns.id),
									entityType: "Namespace",
									...ns,
								} satisfies Item,
							},
						},
					],
				}),
			);
		} catch (err) {
			if (isConditionalFailure(err))
				throw conflict(`Namespace "${ns.name}" already exists`);
			throw err;
		}
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
	 * Move a key to a new `(namespace, name)`: write the new lookup row (blocked
	 * only by a **live** name, so a tombstoned one is free to reclaim), free the
	 * old name, and overwrite/materialize the key definition — all in one
	 * transaction. `key` already carries the new label; `from` is the prior
	 * `(namespaceId, name)`. On `main` the old name is owned here so it is
	 * hard-deleted; on a child branch it may live on an ancestor, so it is shadowed
	 * with a **tombstone** (a plain delete would no-op and the ancestor name would
	 * keep resolving through fall-through). Writing the key definition into the
	 * branch's own partition copies an inherited key down.
	 */
	async renameKeyDef(
		branchId: string,
		key: TranslationKey,
		from: { namespaceId?: string; name: string },
	): Promise<TranslationKey> {
		const items: NonNullable<TransactWriteCommandInput["TransactItems"]> = [
			{
				Put: {
					TableName: this.table,
					Item: keyNameItem(branchId, key),
					ConditionExpression: "attribute_not_exists(SK) OR #deleted = :true",
					ExpressionAttributeNames: { "#deleted": "deleted" },
					ExpressionAttributeValues: { ":true": true },
				},
			},
			branchId === MAIN_BRANCH_ID
				? {
						Delete: {
							TableName: this.table,
							Key: {
								PK: keyDefPK(key.projectId, branchId),
								SK: keyNameSK(from.namespaceId, from.name),
							},
						},
					}
				: {
						Put: {
							TableName: this.table,
							Item: keyNameTombstone(
								key.projectId,
								branchId,
								from.namespaceId,
								from.name,
							),
						},
					},
			{ Put: { TableName: this.table, Item: keyDefItem(branchId, key) } },
		];
		try {
			await this.doc.send(new TransactWriteCommand({ TransactItems: items }));
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

	/** {@link getKeyDef} that also reports which branch the definition resolved
	 * from — used by the resolve-then-materialize (rename/delete) paths. */
	async getKeyDefResolved(
		projectId: string,
		branchId: string,
		keyId: string,
	): Promise<Resolved<TranslationKey> | undefined> {
		return this.getWithProvenance(
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

	/** Every **live** key definition written on this branch — tombstones excluded,
	 * and no parent overlay (use {@link listKeyDefsResolved} for the copy-on-write
	 * view that unions in inherited keys). */
	async listKeyDefs(
		projectId: string,
		branchId: string,
	): Promise<TranslationKey[]> {
		return (await this.keyDefRows(projectId, branchId))
			.filter((row) => row.deleted !== true)
			.map(toKey);
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
				ExclusiveStartKey: this.startKey(
					opts.cursor,
					keyDefPK(projectId, branchId),
				),
			}),
		);
		return {
			keys: ((res.Items as Item[] | undefined) ?? [])
				.filter((row) => row.deleted !== true)
				.map(toKey),
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
		// Nearest branch decides each keyId — a live definition surfaces it, a
		// tombstone (`deleted`) buries it even if an ancestor still has it live.
		const decided = new Map<string, TranslationKey | null>();
		for (const br of chain)
			for (const row of await this.keyDefRows(projectId, br)) {
				const id = row.id as string;
				if (!decided.has(id))
					decided.set(id, row.deleted === true ? null : toKey(row));
			}
		return [...decided.values()].filter((k): k is TranslationKey => k !== null);
	}

	/**
	 * Remove keys and everything beneath them on one branch. A key **owned** by
	 * this branch is hard-deleted — its definition row, `KEYNAME#` lookup row, and
	 * every locale's live cell plus the cell's version chain. A key only
	 * **inherited** from an ancestor can't be physically deleted here, so it is
	 * shadowed with a **tombstone** (a `deleted` definition + name row on this
	 * branch) that stops it resolving through fall-through; any cells this branch
	 * materialized for it are still hard-deleted. On `main` every key is owned, so
	 * this is a pure hard-delete. Batched into 25-item BatchWrite chunks.
	 */
	async deleteKeyDefsCascade(
		projectId: string,
		branchId: string,
		keys: Pick<TranslationKey, "id" | "namespaceId" | "name">[],
	): Promise<void> {
		const onChild = branchId !== MAIN_BRANCH_ID;
		const toDelete: { PK: string; SK: string }[] = [];
		const tombstones: Item[] = [];
		for (const key of keys) {
			// Cells and versions have no fall-through, so any this branch materialized
			// are always hard-deleted.
			for (const k of await this.cellRowKeys(projectId, branchId, key.id))
				toDelete.push(k);
			if (onChild) {
				// Overwrite the def + name rows with tombstones: on a child branch a
				// plain delete can't reach an ancestor's copy, and even a copy this
				// branch owns (e.g. from a rename) would let the ancestor resurface —
				// the tombstone shadows both, and is harmless for a child-only key.
				tombstones.push(keyDefTombstone(projectId, branchId, key.id));
				tombstones.push(
					keyNameTombstone(projectId, branchId, key.namespaceId, key.name),
				);
			} else {
				toDelete.push({
					PK: keyDefPK(projectId, branchId),
					SK: keyDefSK(key.id),
				});
				toDelete.push({
					PK: keyDefPK(projectId, branchId),
					SK: keyNameSK(key.namespaceId, key.name),
				});
			}
		}
		await this.batchDelete(toDelete);
		if (tombstones.length)
			await this.batchWrite(
				tombstones.map((Item) => ({ PutRequest: { Item } })),
			);
	}

	// ---- translation cells ----------------------------------------------------

	async putCell(cell: Translation): Promise<Translation> {
		await this.putItem(cellItem(cell));
		return cell;
	}

	/** Write many live cells efficiently (25 per batch, retrying throttled items). */
	async putCells(list: Translation[]): Promise<void> {
		await this.batchWrite(
			list.map((c) => ({ PutRequest: { Item: cellItem(c) } })),
		);
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

	/** {@link getCell} that also reports which branch the cell resolved from —
	 * used by the resolve-then-mutate paths (accept / escalate / field report). */
	async getCellResolved(
		projectId: string,
		branchId: string,
		keyId: string,
		locale: string,
	): Promise<Resolved<Translation> | undefined> {
		return this.getWithProvenance(
			projectId,
			branchId,
			(br) => cellPK(projectId, br, locale),
			cellSK(keyId),
			toCell,
		);
	}

	/**
	 * Copy-on-write a cell into `branchId` if it is currently **inherited** from an
	 * ancestor, so a subsequent compare-and-swap (accept) has a real child row to
	 * update. Returns the cell now resident on `branchId`, or `undefined` if no
	 * cell exists anywhere in the chain. On `main`, or when the branch already owns
	 * the cell, this is a single read and no write.
	 *
	 * Idempotent and race-safe: the child Put is guarded `attribute_not_exists(SK)`,
	 * so a losing concurrent materialize just reads back the winner's child row.
	 * Re-stamping `branchId` rebuilds the cell's PK/SK **and** its `GSI3PK`, so the
	 * copy lands in the branch's own partition and by-key index. It never advances
	 * `head`, so a following {@link acceptCell} collapses to the ordinary accept
	 * CAS (Put + conditional-Update of one item can't share a transaction).
	 */
	async materializeCell(
		projectId: string,
		branchId: string,
		keyId: string,
		locale: string,
	): Promise<Translation | undefined> {
		const resolved = await this.getCellResolved(
			projectId,
			branchId,
			keyId,
			locale,
		);
		if (!resolved) return undefined;
		if (resolved.branchId === branchId) return resolved.value; // already owned
		const copy: Translation = { ...resolved.value, branchId };
		try {
			await this.putItem(cellItem(copy), "attribute_not_exists(SK)");
		} catch (err) {
			if (!isConditionalFailure(err)) throw err;
			// Lost a concurrent materialize — the child row now exists; read it back.
			return (await this.getCell(projectId, branchId, keyId, locale)) ?? copy;
		}
		return copy;
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

	/**
	 * Every cell **visible** in one branch×locale: the branch's own cells overlaid
	 * on the parent chain (nearest branch wins per key), the copy-on-write export
	 * view. Cells whose key was tombstoned on the branch are dropped (their key no
	 * longer resolves). On `main` this is exactly {@link listCellsByLocale}.
	 * Unpaged by design — an overlaid union can't ride a single `LastEvaluatedKey`.
	 */
	async listCellsByLocaleResolved(
		projectId: string,
		branchId: string,
		locale: string,
	): Promise<Translation[]> {
		const chain = await this.branchChain(projectId, branchId);
		const byKey = new Map<string, Translation>();
		for (const br of chain)
			for (const c of await this.listCellsByLocale(projectId, br, locale))
				if (!byKey.has(c.keyId)) byKey.set(c.keyId, c); // nearest branch wins
		const visible = new Set(
			(await this.listKeyDefsResolved(projectId, branchId)).map((k) => k.id),
		);
		return [...byKey.values()].filter((c) => visible.has(c.keyId));
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
				ExclusiveStartKey: this.startKey(
					opts.cursor,
					cellPK(projectId, branchId, locale),
				),
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

	/** Every locale's cell for one key **visible** on a branch: the branch's own
	 * cells overlaid on the parent chain (nearest branch wins per locale) — the
	 * copy-on-write view for a resolve-then-read. Callers resolve the key first,
	 * so a tombstoned key never reaches here. On `main` this is
	 * {@link listCellsByKey}. */
	async listCellsByKeyResolved(
		projectId: string,
		branchId: string,
		keyId: string,
	): Promise<Translation[]> {
		const chain = await this.branchChain(projectId, branchId);
		const byLocale = new Map<string, Translation>();
		for (const br of chain)
			for (const c of await this.listCellsByKey(projectId, br, keyId))
				if (!byLocale.has(c.locale)) byLocale.set(c.locale, c);
		return [...byLocale.values()];
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
								UpdateExpression: `SET ${sets.join(", ")}`,
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

	/**
	 * {@link getVersion} resolved through the branch's parent chain. A child branch
	 * that accepted a value owns only its own version rows; an inherited head (or
	 * any older version) lives on an ancestor. Versions are immutable, so this
	 * fall-through is always safe — it fixes reading a pinned/accepted value from a
	 * child branch whose cell was inherited, not written.
	 */
	async getVersionResolved(
		projectId: string,
		branchId: string,
		keyId: string,
		locale: string,
		seq: number,
	): Promise<TranslationVersion | undefined> {
		return this.getWithFallthrough(
			projectId,
			branchId,
			(br) => cellPK(projectId, br, locale),
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
	 *
	 * Each cell is flipped with a **targeted conditional `SET stale`** — never a
	 * full-item rewrite — so a value/`head` that a concurrent accept advanced
	 * between this read and write is left untouched (a whole-item `putCells` here
	 * would regress the head). `updatedAt` is deliberately left alone: staleness is
	 * a flag, not an edit, and bumping it would spuriously trip merge-conflict
	 * detection. `exceptLocale` skips one locale — a resolve's fan-out passes the
	 * just-accepted cell's locale so the value it committed isn't re-staled.
	 */
	async markCellsStaleByKey(
		projectId: string,
		branchId: string,
		keyId: string,
		exceptLocale?: string,
	): Promise<number> {
		const cells = await this.listCellsByKey(projectId, branchId, keyId);
		const targets = cells.filter(
			(c) =>
				!c.stale &&
				c.locale !== exceptLocale &&
				c.lifecycle !== "untranslated" &&
				c.lifecycle !== "retired",
		);
		await Promise.all(
			targets.map((c) =>
				this.doc
					.send(
						new UpdateCommand({
							TableName: this.table,
							Key: {
								PK: cellPK(projectId, branchId, c.locale),
								SK: cellSK(keyId),
							},
							UpdateExpression: "SET #stale = :true",
							ExpressionAttributeNames: { "#stale": "stale" },
							ExpressionAttributeValues: { ":true": true },
							ConditionExpression: "attribute_exists(PK)",
						}),
					)
					// A cell deleted between the read and this write is a benign no-op —
					// don't resurrect it (the old full-item write would have) or throw.
					.catch((err) => {
						if (!isConditionalFailure(err)) throw err;
					}),
			),
		);
		return targets.length;
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
		await this.batchWrite(
			entries.map((e) => ({
				PutRequest: {
					Item: releaseEntryItem(release.projectId, release.id, e),
				},
			})),
		);
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

	/** Copy-on-write read (value only) — a thin wrapper over
	 * {@link getWithProvenance} for the callers that don't need the source branch. */
	private async getWithFallthrough<T>(
		projectId: string,
		branchId: string,
		pkFor: (branchId: string) => string,
		sk: string,
		map: (i: Item) => T,
	): Promise<T | undefined> {
		return (await this.getWithProvenance(projectId, branchId, pkFor, sk, map))
			?.value;
	}

	/**
	 * Copy-on-write read reporting **which branch** the value resolved from: try the
	 * branch's own partition first, then fall through to each ancestor up to the
	 * root, returning the first hit mapped to its domain shape plus its branch. On
	 * `main` (or any branch that wrote the row) this is a single get; the ancestor
	 * walk only runs on a miss against a non-root branch.
	 *
	 * A **tombstone** (a row carrying `deleted: true`) short-circuits the walk to
	 * `undefined`: a child branch that deleted/renamed an inherited row writes this
	 * marker so the ancestor's live row stops resolving here.
	 */
	private async getWithProvenance<T>(
		projectId: string,
		branchId: string,
		pkFor: (branchId: string) => string,
		sk: string,
		map: (i: Item) => T,
	): Promise<Resolved<T> | undefined> {
		const own = await this.getRaw(pkFor(branchId), sk);
		if (own)
			return own.deleted === true ? undefined : { value: map(own), branchId };
		if (branchId === MAIN_BRANCH_ID) return undefined; // root has no parent
		const chain = await this.branchChain(projectId, branchId);
		for (let i = 1; i < chain.length; i++) {
			const br = chain[i]!;
			const hit = await this.getRaw(pkFor(br), sk);
			if (hit)
				return hit.deleted === true
					? undefined
					: { value: map(hit), branchId: br };
		}
		return undefined;
	}

	/** The branch ids from `branchId` up to the root, self first. */
	/** Per-instance memo of resolved branch chains. `parentBranchId` is immutable
	 * after creation and branch ids are never reused, so a chain that terminates at
	 * `main` is valid for the life of the process. */
	private readonly branchChainCache = new Map<string, string[]>();

	private async branchChain(
		projectId: string,
		branchId: string,
	): Promise<string[]> {
		const cacheKey = `${projectId}#${branchId}`;
		const cached = this.branchChainCache.get(cacheKey);
		if (cached) return cached;
		const chain: string[] = [];
		let current: string | null | undefined = branchId;
		let complete = false;
		while (current) {
			chain.push(current);
			if (current === MAIN_BRANCH_ID) {
				complete = true;
				break;
			}
			current = (await this.getBranch(projectId, current))?.parentBranchId;
		}
		// Only memoize a chain that reaches `main`; an incomplete one (a branch row
		// not yet visible) could still be completed by a later write.
		if (complete) this.branchChainCache.set(cacheKey, chain);
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
		// Each cell's version rows live in its own (locale) partition, so fan the
		// per-cell version queries out in parallel rather than N sequential round-trips.
		return (
			await Promise.all(
				cells.map(async (cell) => {
					const versions = await this.queryAll({
						TableName: this.table,
						KeyConditionExpression: "PK = :p AND begins_with(SK, :s)",
						ExpressionAttributeValues: {
							":p": cell.PK,
							":s": versionPrefix(keyId),
						},
					});
					return [
						{ PK: cell.PK, SK: cell.SK },
						...versions.map((v) => ({ PK: v.PK, SK: v.SK })),
					];
				}),
			)
		).flat();
	}

	/** Raw `KEY#` key-definition rows on one branch — **including tombstones**
	 * (`deleted` rows), so the resolved overlay can see a child's shadow of an
	 * inherited key. The public list methods map/filter these. */
	private async keyDefRows(
		projectId: string,
		branchId: string,
	): Promise<Item[]> {
		return this.queryAll({
			TableName: this.table,
			KeyConditionExpression: "PK = :p AND begins_with(SK, :s)",
			ExpressionAttributeValues: {
				":p": keyDefPK(projectId, branchId),
				":s": "KEY#",
			},
		});
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
		await this.batchWrite(keys.map((Key) => ({ DeleteRequest: { Key } })));
	}

	/**
	 * Run a BatchWrite to completion in 25-item chunks, **retrying any
	 * `UnprocessedItems`** with exponential backoff until they drain. A plain
	 * `BatchWriteCommand` returns partial success under throttling or item-size
	 * pressure; ignoring `UnprocessedItems` silently drops those writes, so every
	 * batched put/delete funnels through here.
	 */
	private async batchWrite(
		requests: NonNullable<BatchWriteCommandInput["RequestItems"]>[string],
	): Promise<void> {
		for (let i = 0; i < requests.length; i += 25) {
			let pending = requests.slice(i, i + 25);
			for (let attempt = 0; pending.length > 0; attempt++) {
				const res = await this.doc.send(
					new BatchWriteCommand({ RequestItems: { [this.table]: pending } }),
				);
				pending = (res.UnprocessedItems?.[this.table] ?? []) as typeof pending;
				if (pending.length === 0) break;
				if (attempt >= 7)
					throw new Error(
						`BatchWrite left ${pending.length} unprocessed item(s) after ${attempt + 1} attempts`,
					);
				await this.sleep(2 ** attempt * 20);
			}
		}
	}

	/** Sleep helper for backoff between BatchWrite retries. */
	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	/**
	 * Decode a pagination cursor and reject one that belongs to a **different
	 * partition** than the query it's about to drive. A cursor minted for another
	 * collection would make DynamoDB throw a `ValidationException` (masked as a
	 * 500); this turns it into a `VALIDATION` (400) up front.
	 */
	private startKey(
		cursor: string | undefined,
		expectedPK: string,
	): Record<string, unknown> | undefined {
		const key = decodeCursor(cursor);
		if (key && key.PK !== expectedPK)
			throw validation("Pagination cursor does not match the requested list.");
		return key;
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
