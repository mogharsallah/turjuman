import type {
	Actor,
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
import { authenticate, bootstrapOwner } from "../auth.js";
import type { AcceptCellParams, RepositoryApi } from "../repository/index.js";
import { TurjumanService } from "../services/index.js";

/**
 * Order two sort keys the way DynamoDB does — by raw code-unit/byte value, NOT
 * `String.localeCompare` (which is locale-aware and case-folding). The real
 * single-table repo returns rows in SK order; using a locale-aware compare here
 * would let a paging test assert an order the deployed repo doesn't produce.
 */
const compareSk = (a: string, b: string): number =>
	a < b ? -1 : a > b ? 1 : 0;

/**
 * In-memory {@link RepositoryApi} for hermetic tests. It `implements RepositoryApi`
 * (not the concrete class) so the compiler enforces that every public repository
 * method is present and correctly typed — drift becomes a build error, not a
 * runtime `TypeError` discovered mid-test. The DynamoDB-backed `integration.test.ts`
 * exercises the real single-table queries this stand-in approximates, including the
 * copy-on-write fall-through and the accept compare-and-swap modelled here.
 *
 * NOTE: this file lives under `src/testing/` which the package build
 * (`tsconfig.build.json`) excludes from `dist`, so no test code ships in the
 * published `@turjuman/core`. `tsconfig.json` still includes it for typecheck.
 */
export class FakeRepo implements RepositoryApi {
	users = new Map<string, User>();
	emails = new Map<string, string>();
	orgOwners = new Set<string>(); // orgIds that already have a bootstrapped OWNER
	apiKeys = new Map<string, ApiKey>(); // by hash
	projects = new Map<string, Project>();
	memberships = new Map<string, Membership>(); // `${projectId}#${userId}`
	locales = new Map<string, Locale>(); // `${projectId}#${code}`
	branches = new Map<string, Branch>(); // `${projectId}#${branchId}`
	namespaces = new Map<string, Namespace>(); // `${projectId}#${namespaceId}`
	keyDefs = new Map<string, TranslationKey>(); // `${projectId}#${branchId}#${keyId}`
	keyNames = new Map<string, string>(); // `${projectId}#${branchId}#${ns}#${name}` -> keyId
	cells = new Map<string, Translation>(); // `${projectId}#${branchId}#${locale}#${keyId}`
	versions = new Map<string, TranslationVersion>(); // cellKey + `#${seq}`
	glossary = new Map<string, Map<string, GlossaryTerm>>(); // projectId -> termId -> term
	webhooks = new Map<string, Map<string, Webhook>>(); // projectId -> id -> webhook
	qaConfigs = new Map<string, QaConfig>(); // projectId -> config
	runs = new Map<string, TranslationRun>(); // `${projectId}#${runId}`
	contextRules = new Map<string, ContextRule>(); // `${projectId}#${id}`
	examples = new Map<string, Example>(); // `${projectId}#${id}`
	escalations = new Map<string, Escalation>(); // `${projectId}#${id}`
	comments = new Map<string, Comment>(); // `${projectId}#${keyId}#${locale}#${id}`
	releases = new Map<string, Release>(); // `${projectId}#${releaseId}` (entries inline)
	fieldReports = new Map<string, FieldReport>(); // `${projectId}#${id}`

	// ---- composite-key helpers -------------------------------------------------
	private defK = (p: string, b: string, id: string) => `${p}#${b}#${id}`;
	private nameK = (p: string, b: string, ns: string | undefined, n: string) =>
		`${p}#${b}#${ns ?? "_"}#${n}`;
	private cellK = (p: string, b: string, loc: string, id: string) =>
		`${p}#${b}#${loc}#${id}`;

	/** Copy-on-write read: the branch's own value, else the first ancestor's. */
	private fallthrough<T>(
		projectId: string,
		branchId: string,
		get: (branchId: string) => T | undefined,
	): T | undefined {
		const own = get(branchId);
		if (own !== undefined) return own;
		if (branchId === MAIN_BRANCH_ID) return undefined;
		let current: string | null | undefined = this.branches.get(
			`${projectId}#${branchId}`,
		)?.parentBranchId;
		while (current) {
			const hit = get(current);
			if (hit !== undefined) return hit;
			if (current === MAIN_BRANCH_ID) break;
			current = this.branches.get(`${projectId}#${current}`)?.parentBranchId;
		}
		return undefined;
	}

	// ---- users ----------------------------------------------------------------
	async createUser(u: User): Promise<User> {
		// The real Repository reserves the email via a companion item keyed on
		// `emailPK(email)` (lower-cased), so uniqueness is case-insensitive. Mirror
		// that here — lower-case the index key on write, matching `getUserByEmail`'s
		// lookup — or a direct mixed-case `createUser` would store under one key and
		// read back under another (and case-variant duplicates would slip through).
		const emailKey = u.email.toLowerCase();
		if (this.emails.has(emailKey))
			throw conflict(`Email ${u.email} is already in use`);
		this.users.set(u.id, u);
		this.emails.set(emailKey, u.id);
		return u;
	}
	async getUser(id: string): Promise<User | undefined> {
		return this.users.get(id);
	}
	async getUserByEmail(email: string): Promise<User | undefined> {
		const id = this.emails.get(email.toLowerCase());
		return id ? this.users.get(id) : undefined;
	}
	async listUsersByOrg(orgId: string): Promise<User[]> {
		return [...this.users.values()].filter((u) => u.orgId === orgId);
	}
	async setUserGlobalRole(userId: string, role: GlobalRole): Promise<void> {
		const u = this.users.get(userId);
		if (u)
			this.users.set(userId, {
				...u,
				globalRole: role,
				updatedAt: new Date().toISOString(),
			});
	}

	/** Mirrors the real repo's single transaction: rejects a second owner per org
	 * (the `orgOwners` sentinel) or a duplicate email, all-or-nothing. */
	async createOwnerWithKey(user: User, key: ApiKey): Promise<void> {
		const emailKey = user.email.toLowerCase();
		if (this.orgOwners.has(user.orgId))
			throw conflict(`Org "${user.orgId}" already has an owner.`);
		if (this.emails.has(emailKey))
			throw conflict(`Email ${user.email} is already in use`);
		this.orgOwners.add(user.orgId);
		this.users.set(user.id, user);
		this.emails.set(emailKey, user.id);
		this.apiKeys.set(key.hash, key);
	}

	// ---- api keys -------------------------------------------------------------
	async createApiKey(k: ApiKey): Promise<ApiKey> {
		this.apiKeys.set(k.hash, k);
		return k;
	}
	async getApiKeyByHash(hash: string): Promise<ApiKey | undefined> {
		return this.apiKeys.get(hash);
	}
	async listApiKeysByUser(userId: string): Promise<ApiKey[]> {
		return [...this.apiKeys.values()].filter((k) => k.userId === userId);
	}
	async touchApiKey(): Promise<void> {}
	async deleteApiKey(hash: string): Promise<void> {
		this.apiKeys.delete(hash);
	}

	// ---- projects -------------------------------------------------------------
	async createProject(p: Project): Promise<Project> {
		this.projects.set(p.id, p);
		return p;
	}
	async getProject(id: string): Promise<Project | undefined> {
		return this.projects.get(id);
	}
	async listProjectsByOrg(orgId: string): Promise<Project[]> {
		return [...this.projects.values()].filter((p) => p.orgId === orgId);
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
		const p = this.projects.get(projectId);
		if (!p) return;
		this.projects.set(projectId, {
			...p,
			...patch,
			updatedAt: new Date().toISOString(),
		});
	}

	// ---- branches -------------------------------------------------------------
	async putBranch(b: Branch): Promise<Branch> {
		this.branches.set(`${b.projectId}#${b.id}`, b);
		return b;
	}
	async getBranch(
		projectId: string,
		branchId: string,
	): Promise<Branch | undefined> {
		return this.branches.get(`${projectId}#${branchId}`);
	}
	async listBranches(projectId: string): Promise<Branch[]> {
		return [...this.branches.values()].filter((b) => b.projectId === projectId);
	}

	// ---- namespaces -----------------------------------------------------------
	async putNamespace(ns: Namespace): Promise<Namespace> {
		this.namespaces.set(`${ns.projectId}#${ns.id}`, ns);
		return ns;
	}
	async getNamespace(
		projectId: string,
		namespaceId: string,
	): Promise<Namespace | undefined> {
		return this.namespaces.get(`${projectId}#${namespaceId}`);
	}
	async listNamespaces(projectId: string): Promise<Namespace[]> {
		return [...this.namespaces.values()].filter(
			(n) => n.projectId === projectId,
		);
	}

	// ---- memberships ----------------------------------------------------------
	async putMembership(m: Membership): Promise<Membership> {
		this.memberships.set(`${m.projectId}#${m.userId}`, m);
		return m;
	}
	async getMembership(
		projectId: string,
		userId: string,
	): Promise<Membership | undefined> {
		return this.memberships.get(`${projectId}#${userId}`);
	}
	async listMembersByProject(projectId: string): Promise<Membership[]> {
		return [...this.memberships.values()].filter(
			(m) => m.projectId === projectId,
		);
	}
	async listMembershipsByUser(userId: string): Promise<Membership[]> {
		return [...this.memberships.values()].filter((m) => m.userId === userId);
	}
	async deleteMembership(projectId: string, userId: string): Promise<void> {
		this.memberships.delete(`${projectId}#${userId}`);
	}

	// ---- locales --------------------------------------------------------------
	async putLocale(l: Locale): Promise<Locale> {
		this.locales.set(`${l.projectId}#${l.code}`, l);
		return l;
	}
	async getLocale(
		projectId: string,
		code: string,
	): Promise<Locale | undefined> {
		return this.locales.get(`${projectId}#${code}`);
	}
	async listLocales(projectId: string): Promise<Locale[]> {
		return [...this.locales.values()].filter((l) => l.projectId === projectId);
	}
	async deleteLocale(projectId: string, code: string): Promise<void> {
		this.locales.delete(`${projectId}#${code}`);
	}

	// ---- key definitions ------------------------------------------------------
	async createKeyDef(
		branchId: string,
		key: TranslationKey,
	): Promise<TranslationKey> {
		const nk = this.nameK(key.projectId, branchId, key.namespaceId, key.name);
		if (this.keyNames.has(nk))
			throw conflict(`Key "${key.name}" already exists`);
		this.keyDefs.set(this.defK(key.projectId, branchId, key.id), key);
		this.keyNames.set(nk, key.id);
		return key;
	}
	async putKeyDef(
		branchId: string,
		key: TranslationKey,
	): Promise<TranslationKey> {
		this.keyDefs.set(this.defK(key.projectId, branchId, key.id), key);
		return key;
	}
	async renameKeyDef(
		branchId: string,
		key: TranslationKey,
		from: { namespaceId?: string; name: string },
	): Promise<TranslationKey> {
		const nk = this.nameK(key.projectId, branchId, key.namespaceId, key.name);
		if (this.keyNames.has(nk))
			throw conflict(`Key "${key.name}" already exists`);
		this.keyNames.delete(
			this.nameK(key.projectId, branchId, from.namespaceId, from.name),
		);
		this.keyNames.set(nk, key.id);
		this.keyDefs.set(this.defK(key.projectId, branchId, key.id), key);
		return key;
	}
	async getKeyDef(
		projectId: string,
		branchId: string,
		keyId: string,
	): Promise<TranslationKey | undefined> {
		return this.fallthrough(projectId, branchId, (br) =>
			this.keyDefs.get(this.defK(projectId, br, keyId)),
		);
	}
	async resolveKeyIdByName(
		projectId: string,
		branchId: string,
		namespaceId: string | undefined,
		name: string,
	): Promise<string | undefined> {
		return this.fallthrough(projectId, branchId, (br) =>
			this.keyNames.get(this.nameK(projectId, br, namespaceId, name)),
		);
	}
	async listKeyDefs(
		projectId: string,
		branchId: string,
	): Promise<TranslationKey[]> {
		const prefix = `${projectId}#${branchId}#`;
		const out: TranslationKey[] = [];
		for (const [k, v] of this.keyDefs) if (k.startsWith(prefix)) out.push(v);
		return out.sort((a, b) => compareSk(`KEY#${a.id}`, `KEY#${b.id}`));
	}
	async listKeyDefsPage(
		projectId: string,
		branchId: string,
		opts: { limit?: number; cursor?: string } = {},
	): Promise<{ keys: TranslationKey[]; nextCursor?: string }> {
		// The cursor here is an opaque in-memory offset token, not the real repo's
		// key-anchored `LastEvaluatedKey`. Callers must treat it as opaque (the
		// services do); mid-mutation pagination is an integration-tier concern.
		const all = await this.listKeyDefs(projectId, branchId);
		const start = opts.cursor ? Number(opts.cursor) : 0;
		const limit = opts.limit ?? all.length;
		const slice = all.slice(start, start + limit);
		const next = start + limit < all.length ? String(start + limit) : undefined;
		return { keys: slice, nextCursor: next };
	}
	async listKeyDefsResolved(
		projectId: string,
		branchId: string,
	): Promise<TranslationKey[]> {
		// Walk the parent chain like the real repo's branchChain, nearest branch
		// winning per keyId — the copy-on-write key overlay.
		const byId = new Map<string, TranslationKey>();
		let current: string | null | undefined = branchId;
		while (current) {
			for (const k of await this.listKeyDefs(projectId, current))
				if (!byId.has(k.id)) byId.set(k.id, k);
			if (current === MAIN_BRANCH_ID) break;
			current = this.branches.get(`${projectId}#${current}`)?.parentBranchId;
		}
		return [...byId.values()];
	}
	async deleteKeyDefsCascade(
		projectId: string,
		branchId: string,
		keys: Pick<TranslationKey, "id" | "namespaceId" | "name">[],
	): Promise<void> {
		for (const key of keys) {
			this.keyDefs.delete(this.defK(projectId, branchId, key.id));
			this.keyNames.delete(
				this.nameK(projectId, branchId, key.namespaceId, key.name),
			);
			const cellPrefix = `${projectId}#${branchId}#`;
			const cellSuffix = `#${key.id}`;
			for (const [k] of this.cells)
				if (k.startsWith(cellPrefix) && k.endsWith(cellSuffix))
					this.cells.delete(k);
			for (const [k] of this.versions)
				if (k.startsWith(cellPrefix) && k.includes(`${cellSuffix}#`))
					this.versions.delete(k);
		}
	}

	// ---- translation cells ----------------------------------------------------
	async putCell(c: Translation): Promise<Translation> {
		this.cells.set(this.cellK(c.projectId, c.branchId, c.locale, c.keyId), c);
		return c;
	}
	async putCells(list: Translation[]): Promise<void> {
		for (const c of list) await this.putCell(c);
	}
	async getCell(
		projectId: string,
		branchId: string,
		keyId: string,
		locale: string,
	): Promise<Translation | undefined> {
		return this.fallthrough(projectId, branchId, (br) =>
			this.cells.get(this.cellK(projectId, br, locale, keyId)),
		);
	}
	async listCellsByLocale(
		projectId: string,
		branchId: string,
		locale: string,
	): Promise<Translation[]> {
		return [...this.cells.values()]
			.filter(
				(c) =>
					c.projectId === projectId &&
					c.branchId === branchId &&
					c.locale === locale,
			)
			.sort((a, b) => compareSk(`KEY#${a.keyId}`, `KEY#${b.keyId}`));
	}
	async listCellsByLocalePage(
		projectId: string,
		branchId: string,
		locale: string,
		opts: { limit?: number; cursor?: string } = {},
	): Promise<{ cells: Translation[]; nextCursor?: string }> {
		const all = await this.listCellsByLocale(projectId, branchId, locale);
		const start = opts.cursor ? Number(opts.cursor) : 0;
		const limit = opts.limit ?? all.length;
		const slice = all.slice(start, start + limit);
		const next = start + limit < all.length ? String(start + limit) : undefined;
		return { cells: slice, nextCursor: next };
	}
	async listCellsByKey(
		projectId: string,
		branchId: string,
		keyId: string,
	): Promise<Translation[]> {
		return [...this.cells.values()].filter(
			(c) =>
				c.projectId === projectId &&
				c.branchId === branchId &&
				c.keyId === keyId,
		);
	}
	async deleteCell(
		projectId: string,
		branchId: string,
		keyId: string,
		locale: string,
	): Promise<void> {
		this.cells.delete(this.cellK(projectId, branchId, locale, keyId));
	}
	async acceptCell(params: AcceptCellParams): Promise<Translation> {
		const ck = this.cellK(
			params.projectId,
			params.branchId,
			params.locale,
			params.keyId,
		);
		const existing = this.cells.get(ck);
		// Mirror the real repo's CAS: the cell must exist and its `head` must match
		// the caller's expectation, else a concurrent accept already advanced it.
		if (!existing || existing.head !== params.expectedHead)
			throw conflict(
				"Translation changed while accepting; reload and retry the accept.",
			);
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
		this.versions.set(`${ck}#${seq}`, version);
		const updated: Translation = {
			...existing,
			value: params.value,
			head: seq,
			lifecycle: "accepted",
			stale: false,
			sourceRef: params.sourceRevision,
			origin: params.origin ?? existing.origin,
			lockedByRunId: undefined,
			updatedBy: params.updatedBy,
			updatedAt: now,
		};
		this.cells.set(ck, updated);
		return updated;
	}
	async getVersion(
		projectId: string,
		branchId: string,
		keyId: string,
		locale: string,
		seq: number,
	): Promise<TranslationVersion | undefined> {
		return this.versions.get(
			`${this.cellK(projectId, branchId, locale, keyId)}#${seq}`,
		);
	}
	async getCellHistory(
		projectId: string,
		branchId: string,
		keyId: string,
		locale: string,
	): Promise<TranslationVersion[]> {
		return [...this.versions.values()]
			.filter(
				(v) =>
					v.projectId === projectId &&
					v.branchId === branchId &&
					v.keyId === keyId &&
					v.locale === locale,
			)
			.sort((a, b) => a.seq - b.seq);
	}

	// ---- glossary -------------------------------------------------------------
	private glossaryMap(projectId: string): Map<string, GlossaryTerm> {
		let m = this.glossary.get(projectId);
		if (!m) this.glossary.set(projectId, (m = new Map()));
		return m;
	}
	async putGlossaryTerm(term: GlossaryTerm): Promise<GlossaryTerm> {
		this.glossaryMap(term.projectId).set(term.id, term);
		return term;
	}
	async getGlossaryTerm(
		projectId: string,
		termId: string,
	): Promise<GlossaryTerm | undefined> {
		return this.glossaryMap(projectId).get(termId);
	}
	async listGlossary(projectId: string): Promise<GlossaryTerm[]> {
		return [...this.glossaryMap(projectId).values()];
	}
	async deleteGlossaryTerm(projectId: string, termId: string): Promise<void> {
		this.glossaryMap(projectId).delete(termId);
	}

	// ---- context rules --------------------------------------------------------
	async putContextRule(rule: ContextRule): Promise<ContextRule> {
		this.contextRules.set(`${rule.projectId}#${rule.id}`, rule);
		return rule;
	}
	async getContextRule(
		projectId: string,
		id: string,
	): Promise<ContextRule | undefined> {
		return this.contextRules.get(`${projectId}#${id}`);
	}
	async listContextRules(projectId: string): Promise<ContextRule[]> {
		return [...this.contextRules.values()].filter(
			(r) => r.projectId === projectId,
		);
	}
	async deleteContextRule(projectId: string, id: string): Promise<void> {
		this.contextRules.delete(`${projectId}#${id}`);
	}

	// ---- examples -------------------------------------------------------------
	async putExample(example: Example): Promise<Example> {
		this.examples.set(`${example.projectId}#${example.id}`, example);
		return example;
	}
	async getExample(
		projectId: string,
		id: string,
	): Promise<Example | undefined> {
		return this.examples.get(`${projectId}#${id}`);
	}
	async listExamples(projectId: string): Promise<Example[]> {
		return [...this.examples.values()].filter((e) => e.projectId === projectId);
	}
	async deleteExample(projectId: string, id: string): Promise<void> {
		this.examples.delete(`${projectId}#${id}`);
	}

	// ---- comments -------------------------------------------------------------
	async putComment(comment: Comment): Promise<Comment> {
		this.comments.set(
			`${comment.projectId}#${comment.keyId}#${comment.locale}#${comment.id}`,
			comment,
		);
		return comment;
	}
	async listComments(
		projectId: string,
		keyId: string,
		locale: string,
	): Promise<Comment[]> {
		return [...this.comments.values()]
			.filter(
				(c) =>
					c.projectId === projectId && c.keyId === keyId && c.locale === locale,
			)
			.sort((a, b) => compareSk(a.id, b.id));
	}
	async deleteComment(
		projectId: string,
		keyId: string,
		locale: string,
		id: string,
	): Promise<void> {
		this.comments.delete(`${projectId}#${keyId}#${locale}#${id}`);
	}

	// ---- escalations ----------------------------------------------------------
	async putEscalation(escalation: Escalation): Promise<Escalation> {
		this.escalations.set(
			`${escalation.projectId}#${escalation.id}`,
			escalation,
		);
		return escalation;
	}
	async getEscalation(
		projectId: string,
		id: string,
	): Promise<Escalation | undefined> {
		return this.escalations.get(`${projectId}#${id}`);
	}
	async listEscalations(projectId: string): Promise<Escalation[]> {
		return [...this.escalations.values()].filter(
			(e) => e.projectId === projectId,
		);
	}
	/** Mirrors the real repo's claim CAS: only an open, unclaimed escalation can be
	 * claimed; a racing second claim loses with CONFLICT. */
	async claimEscalation(
		projectId: string,
		id: string,
		userId: string,
		at: string,
	): Promise<Escalation> {
		const e = this.escalations.get(`${projectId}#${id}`);
		if (!e) throw conflict(`Escalation ${id} not found`);
		if (e.claimedBy || e.status !== "open")
			throw conflict("Escalation already claimed or resolved");
		const updated: Escalation = { ...e, claimedBy: userId, claimedAt: at };
		this.escalations.set(`${projectId}#${id}`, updated);
		return updated;
	}

	// ---- context staleness fan-out --------------------------------------------
	async bumpContextRevision(projectId: string): Promise<number> {
		const p = this.projects.get(projectId);
		if (!p) throw conflict(`Project ${projectId} not found`);
		const next = (p.contextRevision ?? 0) + 1;
		this.projects.set(projectId, {
			...p,
			contextRevision: next,
			updatedAt: new Date().toISOString(),
		});
		return next;
	}
	async markCellsStaleByKey(
		projectId: string,
		branchId: string,
		keyId: string,
	): Promise<number> {
		const cells = await this.listCellsByKey(projectId, branchId, keyId);
		const touched = cells.filter(
			(c) =>
				!c.stale && c.lifecycle !== "untranslated" && c.lifecycle !== "retired",
		);
		for (const c of touched) await this.putCell({ ...c, stale: true });
		return touched.length;
	}

	// ---- webhooks -------------------------------------------------------------
	private webhookMap(projectId: string): Map<string, Webhook> {
		let m = this.webhooks.get(projectId);
		if (!m) this.webhooks.set(projectId, (m = new Map()));
		return m;
	}
	async putWebhook(webhook: Webhook): Promise<Webhook> {
		this.webhookMap(webhook.projectId).set(webhook.id, webhook);
		return webhook;
	}
	async getWebhook(
		projectId: string,
		id: string,
	): Promise<Webhook | undefined> {
		return this.webhookMap(projectId).get(id);
	}
	async listWebhooks(projectId: string): Promise<Webhook[]> {
		return [...this.webhookMap(projectId).values()];
	}
	async deleteWebhook(projectId: string, id: string): Promise<void> {
		this.webhookMap(projectId).delete(id);
	}

	// ---- QA config (per-project singleton) ------------------------------------
	async getQaConfig(projectId: string): Promise<QaConfig | undefined> {
		return this.qaConfigs.get(projectId);
	}
	async putQaConfig(config: QaConfig): Promise<QaConfig> {
		this.qaConfigs.set(config.projectId, config);
		return config;
	}

	// ---- runs -----------------------------------------------------------------
	async putRun(run: TranslationRun): Promise<TranslationRun> {
		this.runs.set(`${run.projectId}#${run.id}`, run);
		return run;
	}
	async getRun(
		projectId: string,
		runId: string,
	): Promise<TranslationRun | undefined> {
		return this.runs.get(`${projectId}#${runId}`);
	}
	async listRunsByBranch(
		projectId: string,
		branchId: string,
	): Promise<TranslationRun[]> {
		return [...this.runs.values()].filter(
			(r) => r.projectId === projectId && r.branchId === branchId,
		);
	}

	// ---- releases -------------------------------------------------------------
	async putRelease(release: Release): Promise<Release> {
		this.releases.set(`${release.projectId}#${release.id}`, release);
		return release;
	}
	async getRelease(
		projectId: string,
		releaseId: string,
	): Promise<Release | undefined> {
		return this.releases.get(`${projectId}#${releaseId}`);
	}
	async listReleases(projectId: string): Promise<Release[]> {
		// Mirror the real repo: the list view carries metadata only (entries are
		// separate rows there), so a test can't lean on list including entries.
		return [...this.releases.values()]
			.filter((r) => r.projectId === projectId)
			.map((r) => ({ ...r, entries: [] }));
	}
	async setReleaseStatus(
		projectId: string,
		releaseId: string,
		status: Release["status"],
	): Promise<void> {
		const r = this.releases.get(`${projectId}#${releaseId}`);
		if (r) this.releases.set(`${projectId}#${releaseId}`, { ...r, status });
	}

	// ---- field reports --------------------------------------------------------
	async putFieldReport(report: FieldReport): Promise<FieldReport> {
		this.fieldReports.set(`${report.projectId}#${report.id}`, report);
		return report;
	}
	async getFieldReport(
		projectId: string,
		id: string,
	): Promise<FieldReport | undefined> {
		return this.fieldReports.get(`${projectId}#${id}`);
	}
	async listFieldReports(projectId: string): Promise<FieldReport[]> {
		return [...this.fieldReports.values()].filter(
			(r) => r.projectId === projectId,
		);
	}

	// ---- project cascade ------------------------------------------------------
	async deleteProjectCascade(
		projectId: string,
		_localeCodes: string[],
	): Promise<void> {
		this.projects.delete(projectId);
		this.glossary.delete(projectId);
		this.webhooks.delete(projectId);
		this.qaConfigs.delete(projectId);
		const dropByPrefix = (m: Map<string, unknown>) => {
			for (const [k] of m) if (k.startsWith(`${projectId}#`)) m.delete(k);
		};
		dropByPrefix(this.locales);
		dropByPrefix(this.branches);
		dropByPrefix(this.namespaces);
		dropByPrefix(this.keyDefs);
		dropByPrefix(this.keyNames);
		dropByPrefix(this.cells);
		dropByPrefix(this.versions);
		dropByPrefix(this.runs);
		dropByPrefix(this.contextRules);
		dropByPrefix(this.examples);
		dropByPrefix(this.escalations);
		dropByPrefix(this.comments);
		dropByPrefix(this.releases);
		dropByPrefix(this.fieldReports);
		for (const [k, m] of this.memberships)
			if (m.projectId === projectId) this.memberships.delete(k);
	}
}

/** Fresh fake repo per call — never share an instance across tests (vitest runs
 * files in parallel; shared mutable state is a flake). */
export function makeFakeRepo(): FakeRepo {
	return new FakeRepo();
}

/** A fake repo wired to a real {@link TurjumanService}, the common test setup. */
export function setup(): { repo: FakeRepo; svc: TurjumanService } {
	const repo = makeFakeRepo();
	return { repo, svc: new TurjumanService(repo) };
}

/** Bootstrap an OWNER and return their authenticated actor + secret. */
export async function ownerActor(
	repo: FakeRepo,
	opts: { email?: string; name?: string } = {},
): Promise<{ actor: Actor; secret: string }> {
	const boot = await bootstrapOwner(repo, {
		email: opts.email ?? "owner@acme.com",
		name: opts.name ?? "Owner",
	});
	const actor = (await authenticate(repo, boot.secret))!.actor;
	return { actor, secret: boot.secret };
}
