import type {
	Actor,
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
import { authenticate, bootstrapOwner } from "../auth.js";
import type { RepositoryApi } from "../repository/index.js";
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
 * exercises the real single-table queries this stand-in approximates.
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
	keys = new Map<string, Map<string, TranslationKey>>(); // projectId -> sk -> key
	translations = new Map<string, Map<string, Translation>>(); // projectId -> `${loc}#${ns}#${name}`
	glossary = new Map<string, Map<string, GlossaryTerm>>(); // projectId -> termId -> term
	webhooks = new Map<string, Map<string, Webhook>>(); // projectId -> id -> webhook
	qaConfigs = new Map<string, QaConfig>(); // projectId -> config
	scoreConfigs = new Map<string, ScoreConfig>(); // projectId -> config

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
		patch: Partial<Pick<Project, "name" | "description" | "baseLocale">>,
	): Promise<void> {
		const p = this.projects.get(projectId);
		if (!p) return;
		this.projects.set(projectId, {
			...p,
			...patch,
			updatedAt: new Date().toISOString(),
		});
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

	// ---- translation keys -----------------------------------------------------
	private keyMap(projectId: string): Map<string, TranslationKey> {
		let m = this.keys.get(projectId);
		if (!m) this.keys.set(projectId, (m = new Map()));
		return m;
	}
	async putKey(k: TranslationKey): Promise<TranslationKey> {
		this.keyMap(k.projectId).set(`${k.namespace}#${k.name}`, k);
		return k;
	}
	async getKey(
		projectId: string,
		ns: string,
		name: string,
	): Promise<TranslationKey | undefined> {
		return this.keyMap(projectId).get(`${ns}#${name}`);
	}
	async listKeys(
		projectId: string,
		namespace?: string,
	): Promise<TranslationKey[]> {
		const all = [...this.keyMap(projectId).values()].sort((a, b) =>
			compareSk(`${a.namespace}#${a.name}`, `${b.namespace}#${b.name}`),
		);
		return namespace ? all.filter((k) => k.namespace === namespace) : all;
	}
	async listKeysPage(
		projectId: string,
		opts: { namespace?: string; limit?: number; cursor?: string } = {},
	): Promise<{ keys: TranslationKey[]; nextCursor?: string }> {
		// The cursor here is an opaque in-memory offset token, not the real repo's
		// key-anchored `LastEvaluatedKey`. Callers must treat it as opaque (the
		// services do); a test that paginates while concurrently inserting/deleting
		// keys would see offset drift the real key-anchored cursor doesn't have — so
		// mid-mutation pagination is an integration-tier (real-DynamoDB) concern.
		const all = await this.listKeys(projectId, opts.namespace);
		const start = opts.cursor ? Number(opts.cursor) : 0;
		const limit = opts.limit ?? all.length;
		const slice = all.slice(start, start + limit);
		const next = start + limit < all.length ? String(start + limit) : undefined;
		return { keys: slice, nextCursor: next };
	}
	async deleteKey(projectId: string, ns: string, name: string): Promise<void> {
		this.keyMap(projectId).delete(`${ns}#${name}`);
	}
	async deleteKeysCascade(
		projectId: string,
		ns: string,
		names: string[],
	): Promise<void> {
		for (const name of names) {
			for (const t of await this.listTranslationsByKey(projectId, ns, name)) {
				await this.deleteTranslation(projectId, t.localeCode, ns, name);
			}
			await this.deleteKey(projectId, ns, name);
		}
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

	// ---- QA + scoring config (per-project singletons) -------------------------
	async getQaConfig(projectId: string): Promise<QaConfig | undefined> {
		return this.qaConfigs.get(projectId);
	}
	async putQaConfig(config: QaConfig): Promise<QaConfig> {
		this.qaConfigs.set(config.projectId, config);
		return config;
	}
	async getScoreConfig(projectId: string): Promise<ScoreConfig | undefined> {
		return this.scoreConfigs.get(projectId);
	}
	async putScoreConfig(config: ScoreConfig): Promise<ScoreConfig> {
		this.scoreConfigs.set(config.projectId, config);
		return config;
	}

	async deleteProjectCascade(
		projectId: string,
		localeCodes: string[],
	): Promise<void> {
		this.projects.delete(projectId);
		this.keys.delete(projectId);
		this.glossary.delete(projectId);
		this.webhooks.delete(projectId);
		this.qaConfigs.delete(projectId);
		this.scoreConfigs.delete(projectId);
		for (const [k] of this.locales)
			if (k.startsWith(`${projectId}#`)) this.locales.delete(k);
		for (const [k, m] of this.memberships)
			if (m.projectId === projectId) this.memberships.delete(k);
		const trans = this.translations.get(projectId);
		if (trans) {
			for (const [k, t] of trans)
				if (localeCodes.includes(t.localeCode)) trans.delete(k);
		}
	}

	// ---- translations ---------------------------------------------------------
	private transMap(projectId: string): Map<string, Translation> {
		let m = this.translations.get(projectId);
		if (!m) this.translations.set(projectId, (m = new Map()));
		return m;
	}
	async putTranslation(t: Translation): Promise<Translation> {
		this.transMap(t.projectId).set(
			`${t.localeCode}#${t.namespace}#${t.keyName}`,
			t,
		);
		return t;
	}
	async putTranslations(list: Translation[]): Promise<void> {
		for (const t of list) await this.putTranslation(t);
	}
	async getTranslation(
		projectId: string,
		code: string,
		ns: string,
		name: string,
	): Promise<Translation | undefined> {
		return this.transMap(projectId).get(`${code}#${ns}#${name}`);
	}
	async listTranslationsByLocale(
		projectId: string,
		code: string,
	): Promise<Translation[]> {
		return [...this.transMap(projectId).values()].filter(
			(t) => t.localeCode === code,
		);
	}
	async listTranslationsByLocalePage(
		projectId: string,
		code: string,
		opts: { limit?: number; cursor?: string } = {},
	): Promise<{ translations: Translation[]; nextCursor?: string }> {
		const all = (await this.listTranslationsByLocale(projectId, code)).sort(
			(a, b) =>
				compareSk(`${a.namespace}#${a.keyName}`, `${b.namespace}#${b.keyName}`),
		);
		const start = opts.cursor ? Number(opts.cursor) : 0;
		const limit = opts.limit ?? all.length;
		const slice = all.slice(start, start + limit);
		const next = start + limit < all.length ? String(start + limit) : undefined;
		return { translations: slice, nextCursor: next };
	}
	async listTranslationsByKey(
		projectId: string,
		ns: string,
		name: string,
	): Promise<Translation[]> {
		return [...this.transMap(projectId).values()].filter(
			(t) => t.namespace === ns && t.keyName === name,
		);
	}
	async deleteTranslation(
		projectId: string,
		code: string,
		ns: string,
		name: string,
	): Promise<void> {
		this.transMap(projectId).delete(`${code}#${ns}#${name}`);
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
