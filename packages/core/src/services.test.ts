import { describe, expect, it } from "vitest";
import type {
  ApiKey,
  GlossaryTerm,
  Locale,
  Membership,
  Project,
  QaConfig,
  Translation,
  TranslationKey,
  User,
} from "@turjuman/schema";
import { authenticate, bootstrapOwner } from "./auth.js";
import { conflict } from "@turjuman/schema";
import type { Repository } from "./repository/index.js";
import { TurjumanService } from "./services/index.js";

/**
 * Hermetic service-layer tests over an in-memory Repository stand-in. This keeps
 * the business logic (RBAC, prune, pagination, revocation, auto-provision) under
 * test in the default `npm test` run; the DynamoDB-backed integration.test.ts
 * additionally exercises the real single-table queries.
 */

class FakeRepo {
  users = new Map<string, User>();
  emails = new Map<string, string>();
  apiKeys = new Map<string, ApiKey>(); // by hash
  projects = new Map<string, Project>();
  memberships = new Map<string, Membership>(); // `${projectId}#${userId}`
  locales = new Map<string, Locale>(); // `${projectId}#${code}`
  keys = new Map<string, Map<string, TranslationKey>>(); // projectId -> sk -> key
  translations = new Map<string, Map<string, Translation>>(); // projectId -> `${loc}#${ns}#${name}`
  glossaryTerms = new Map<string, GlossaryTerm[]>(); // projectId -> terms
  qaConfigs = new Map<string, QaConfig>(); // projectId -> config

  // users
  async createUser(u: User): Promise<User> {
    if (this.emails.has(u.email)) throw conflict(`Email ${u.email} is already in use`);
    this.users.set(u.id, u);
    this.emails.set(u.email, u.id);
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
  async setUserGlobalRole(): Promise<void> {}

  // api keys
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

  // projects
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

  // memberships
  async putMembership(m: Membership): Promise<Membership> {
    this.memberships.set(`${m.projectId}#${m.userId}`, m);
    return m;
  }
  async getMembership(projectId: string, userId: string): Promise<Membership | undefined> {
    return this.memberships.get(`${projectId}#${userId}`);
  }
  async listMembershipsByUser(userId: string): Promise<Membership[]> {
    return [...this.memberships.values()].filter((m) => m.userId === userId);
  }

  // locales
  async putLocale(l: Locale): Promise<Locale> {
    this.locales.set(`${l.projectId}#${l.code}`, l);
    return l;
  }
  async getLocale(projectId: string, code: string): Promise<Locale | undefined> {
    return this.locales.get(`${projectId}#${code}`);
  }
  async listLocales(projectId: string): Promise<Locale[]> {
    return [...this.locales.values()].filter((l) => l.projectId === projectId);
  }

  // keys
  private keyMap(projectId: string): Map<string, TranslationKey> {
    let m = this.keys.get(projectId);
    if (!m) this.keys.set(projectId, (m = new Map()));
    return m;
  }
  async putKey(k: TranslationKey): Promise<TranslationKey> {
    this.keyMap(k.projectId).set(`${k.namespace}#${k.name}`, k);
    return k;
  }
  async getKey(projectId: string, ns: string, name: string): Promise<TranslationKey | undefined> {
    return this.keyMap(projectId).get(`${ns}#${name}`);
  }
  async listKeys(projectId: string, namespace?: string): Promise<TranslationKey[]> {
    const all = [...this.keyMap(projectId).values()].sort((a, b) =>
      `${a.namespace}#${a.name}`.localeCompare(`${b.namespace}#${b.name}`),
    );
    return namespace ? all.filter((k) => k.namespace === namespace) : all;
  }
  async listKeysPage(
    projectId: string,
    opts: { namespace?: string; limit?: number; cursor?: string } = {},
  ): Promise<{ keys: TranslationKey[]; nextCursor?: string }> {
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
  async deleteKeysCascade(projectId: string, ns: string, names: string[]): Promise<void> {
    for (const name of names) {
      for (const t of await this.listTranslationsByKey(projectId, ns, name)) {
        await this.deleteTranslation(projectId, t.localeCode, ns, name);
      }
      await this.deleteKey(projectId, ns, name);
    }
  }

  // translations
  private transMap(projectId: string): Map<string, Translation> {
    let m = this.translations.get(projectId);
    if (!m) this.translations.set(projectId, (m = new Map()));
    return m;
  }
  async putTranslation(t: Translation): Promise<Translation> {
    this.transMap(t.projectId).set(`${t.localeCode}#${t.namespace}#${t.keyName}`, t);
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
  async listTranslationsByLocale(projectId: string, code: string): Promise<Translation[]> {
    return [...this.transMap(projectId).values()].filter((t) => t.localeCode === code);
  }
  async listTranslationsByLocalePage(
    projectId: string,
    code: string,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<{ translations: Translation[]; nextCursor?: string }> {
    const all = (await this.listTranslationsByLocale(projectId, code)).sort((a, b) =>
      `${a.namespace}#${a.keyName}`.localeCompare(`${b.namespace}#${b.keyName}`),
    );
    const start = opts.cursor ? Number(opts.cursor) : 0;
    const limit = opts.limit ?? all.length;
    const slice = all.slice(start, start + limit);
    const next = start + limit < all.length ? String(start + limit) : undefined;
    return { translations: slice, nextCursor: next };
  }
  async listTranslationsByKey(projectId: string, ns: string, name: string): Promise<Translation[]> {
    return [...this.transMap(projectId).values()].filter(
      (t) => t.namespace === ns && t.keyName === name,
    );
  }
  async deleteTranslation(projectId: string, code: string, ns: string, name: string): Promise<void> {
    this.transMap(projectId).delete(`${code}#${ns}#${name}`);
  }

  // glossary + QA config
  async listGlossary(projectId: string): Promise<GlossaryTerm[]> {
    return this.glossaryTerms.get(projectId) ?? [];
  }
  async getQaConfig(projectId: string): Promise<QaConfig | undefined> {
    return this.qaConfigs.get(projectId);
  }
  async putQaConfig(config: QaConfig): Promise<QaConfig> {
    this.qaConfigs.set(config.projectId, config);
    return config;
  }
}

function setup() {
  const repo = new FakeRepo();
  const svc = new TurjumanService(repo as unknown as Repository);
  return { repo, svc };
}

async function ownerActor(repo: FakeRepo, svc: TurjumanService) {
  const boot = await bootstrapOwner(repo as unknown as Repository, {
    email: "owner@acme.com",
    name: "Owner",
  });
  const actor = (await authenticate(repo as unknown as Repository, boot.secret))!.actor;
  return { actor, secret: boot.secret };
}

describe("TurjumanService (in-memory)", () => {
  it("bootstrap refuses a second owner unless forced", async () => {
    const { repo, svc } = setup();
    await ownerActor(repo, svc);
    await expect(
      bootstrapOwner(repo as unknown as Repository, { email: "two@acme.com", name: "Two" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const forced = await bootstrapOwner(repo as unknown as Repository, {
      email: "two@acme.com",
      name: "Two",
      force: true,
    });
    expect(forced.user.globalRole).toBe("OWNER");
  });

  it("revokes an API key so it no longer authenticates", async () => {
    const { repo, svc } = setup();
    const { actor } = await ownerActor(repo, svc);
    const minted = await svc.apiKeys.create(actor, { name: "ci" });
    expect(await authenticate(repo as unknown as Repository, minted.secret)).toBeTruthy();
    const res = await svc.apiKeys.revoke(actor, minted.apiKey.id);
    expect(res.revoked).toBe(minted.apiKey.id);
    expect(await authenticate(repo as unknown as Repository, minted.secret)).toBeUndefined();
    await expect(svc.apiKeys.revoke(actor, "key_missing")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("auto-provisions an unknown email on add_member for an admin", async () => {
    const { repo, svc } = setup();
    const { actor } = await ownerActor(repo, svc);
    const project = await svc.projects.create(actor, { name: "App", baseLocale: "en" });
    const m = await svc.members.add(actor, project.id, { email: "newbie@acme.com" }, "EDITOR");
    expect(m.role).toBe("EDITOR");
    expect((await svc.users.list(actor)).map((u) => u.email)).toContain("newbie@acme.com");
  });

  it("gives a clear error when a non-admin adds an unknown email", async () => {
    const { repo, svc } = setup();
    const { actor } = await ownerActor(repo, svc);
    const project = await svc.projects.create(actor, { name: "App", baseLocale: "en" });
    // A MANAGER who is only a global MEMBER cannot provision org users.
    const member = await svc.users.create(actor, { email: "mgr@acme.com", name: "Mgr" });
    await svc.members.add(actor, project.id, { userId: member.id }, "MANAGER");
    const mgrKey = await svc.apiKeys.create(actor, { name: "k", userId: member.id });
    const mgrActor = (await authenticate(repo as unknown as Repository, mgrKey.secret))!.actor;
    await expect(
      svc.members.add(mgrActor, project.id, { email: "ghost@acme.com" }, "EDITOR"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("prunes keys absent from an importKeys batch", async () => {
    const { repo, svc } = setup();
    const { actor } = await ownerActor(repo, svc);
    const project = await svc.projects.create(actor, { name: "App", baseLocale: "en" });
    await svc.keys.import(actor, project.id, [
      { name: "keep.me", baseValue: "Keep" },
      { name: "drop.me", baseValue: "Drop" },
    ]);
    const res = await svc.keys.import(
      actor,
      project.id,
      [{ name: "keep.me", baseValue: "Keep" }],
      "default",
      { prune: true },
    );
    expect(res.deleted).toBe(1);
    expect((await svc.keys.list(actor, project.id)).map((k) => k.name)).toEqual(["keep.me"]);
    expect(await svc.translations.listForKey(actor, project.id, "drop.me")).toHaveLength(0);
  });

  it("soft-deprecates keys absent from an import and restores them on return", async () => {
    const { repo, svc } = setup();
    const { actor } = await ownerActor(repo, svc);
    const project = await svc.projects.create(actor, { name: "App", baseLocale: "en" });
    await svc.keys.import(actor, project.id, [
      { name: "keep.me", baseValue: "Keep" },
      { name: "drop.me", baseValue: "Drop" },
    ]);

    // A later authoritative import without drop.me deprecates it (retained, not deleted).
    const res = await svc.keys.import(
      actor,
      project.id,
      [{ name: "keep.me", baseValue: "Keep" }],
      "default",
      { deprecateAbsent: true },
    );
    expect(res.deprecated).toBe(1);
    expect(res.deleted).toBe(0);
    // Hidden from the default listing, but its translations are kept.
    expect((await svc.keys.list(actor, project.id)).map((k) => k.name)).toEqual(["keep.me"]);
    expect((await svc.keys.list(actor, project.id, { includeDeprecated: true })).map((k) => k.name)).toEqual(
      ["drop.me", "keep.me"],
    );
    expect(await svc.translations.listForKey(actor, project.id, "drop.me")).toHaveLength(1);

    // Re-importing drop.me reactivates it.
    const back = await svc.keys.import(actor, project.id, [
      { name: "keep.me" },
      { name: "drop.me" },
    ]);
    expect(back.reactivated).toBe(1);
    expect((await svc.keys.list(actor, project.id)).map((k) => k.name)).toEqual(["drop.me", "keep.me"]);
  });

  it("only an OWNER may grant or change privileged roles", async () => {
    const { repo, svc } = setup();
    const { actor: owner } = await ownerActor(repo, svc);
    // Owner promotes someone to ADMIN, then acts as that admin.
    const adminUser = await svc.users.create(owner, {
      email: "admin@acme.com",
      name: "Admin",
      globalRole: "ADMIN",
    });
    const adminKey = await svc.apiKeys.create(owner, { name: "k", userId: adminUser.id });
    const adminActor = (await authenticate(repo as unknown as Repository, adminKey.secret))!.actor;
    const memberUser = await svc.users.create(owner, { email: "m@acme.com", name: "M" });

    // ADMIN cannot promote a MEMBER into the privileged tier...
    await expect(svc.users.setGlobalRole(adminActor, memberUser.id, "ADMIN")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      svc.users.create(adminActor, { email: "x@acme.com", name: "X", globalRole: "ADMIN" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // ...but an OWNER can.
    await expect(svc.users.setGlobalRole(owner, memberUser.id, "ADMIN")).resolves.toBeUndefined();
  });

  it("refuses to demote the last owner but allows it when another owner remains", async () => {
    const { repo, svc } = setup();
    const { actor: owner } = await ownerActor(repo, svc);
    await expect(svc.users.setGlobalRole(owner, owner.userId, "MEMBER")).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const second = await svc.users.create(owner, {
      email: "two@acme.com",
      name: "Two",
      globalRole: "OWNER",
    });
    await expect(svc.users.setGlobalRole(owner, second.id, "MEMBER")).resolves.toBeUndefined();
  });

  it("does not list API keys for a user in another org", async () => {
    const { repo, svc } = setup();
    const { actor: owner } = await ownerActor(repo, svc);
    await repo.createUser({
      id: "user_other",
      orgId: "other-org",
      email: "outsider@other.com",
      name: "Outsider",
      globalRole: "MEMBER",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await expect(svc.apiKeys.list(owner, "user_other")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("paginates list_keys via the cursor", async () => {
    const { repo, svc } = setup();
    const { actor } = await ownerActor(repo, svc);
    const project = await svc.projects.create(actor, { name: "App", baseLocale: "en" });
    for (let i = 0; i < 5; i++) await svc.keys.create(actor, project.id, { name: `k${i}` });
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await svc.keys.listPage(actor, project.id, { limit: 2, cursor });
      page.keys.forEach((k) => seen.add(k.name));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(seen.size).toBe(5);
    expect(pages).toBe(3);
  });

  it("paginates translations and the bundle export, matching the whole-locale result", async () => {
    const { repo, svc } = setup();
    const { actor } = await ownerActor(repo, svc);
    const project = await svc.projects.create(actor, { name: "App", baseLocale: "en" });
    await svc.locales.add(actor, project.id, "fr");
    for (let i = 0; i < 5; i++) {
      await svc.keys.create(actor, project.id, { name: `k${i}`, baseValue: `Base${i}` });
      await svc.translations.set(actor, project.id, "fr", {
        name: `k${i}`,
        value: `Fr${i}`,
        status: "approved",
      });
    }

    // Walk a helper that drains every page at a given limit.
    const drain = async <T>(
      fetch: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>,
    ): Promise<{ items: T[]; pages: number }> => {
      const items: T[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await fetch(cursor);
        items.push(...page.items);
        cursor = page.nextCursor;
        pages++;
      } while (cursor && pages < 20);
      return { items, pages };
    };

    // Raw translation list: paged walk equals the whole list.
    const whole = await svc.translations.listForLocale(actor, project.id, "fr");
    const pagedT = await drain(async (cursor) => {
      const p = await svc.translations.listForLocalePage(actor, project.id, "fr", { limit: 2, cursor });
      return { items: p.translations, nextCursor: p.nextCursor };
    });
    expect(pagedT.pages).toBe(3);
    expect(new Set(pagedT.items.map((t) => t.keyName))).toEqual(
      new Set(whole.map((t) => t.keyName)),
    );

    // Bundle export: paged walk (with its per-page key/base join) equals the whole bundle.
    const wholeBundle = await svc.translations.exportBundle(actor, project.id, "fr");
    const pagedB = await drain(async (cursor) => {
      const p = await svc.translations.exportBundlePage(actor, project.id, "fr", { limit: 2, cursor });
      return { items: p.entries, nextCursor: p.nextCursor };
    });
    const norm = (es: typeof wholeBundle) =>
      Object.fromEntries(es.map((e) => [`${e.namespace}#${e.key}`, e.value]));
    expect(norm(pagedB.items)).toEqual(norm(wholeBundle));
    expect(pagedB.items).toHaveLength(5);
  });

  it("paged bundle export honors deprecated-key exclusion like the whole export", async () => {
    const { repo, svc } = setup();
    const { actor } = await ownerActor(repo, svc);
    const project = await svc.projects.create(actor, { name: "App", baseLocale: "en" });
    await svc.locales.add(actor, project.id, "fr");
    await svc.keys.create(actor, project.id, { name: "keep", baseValue: "Keep" });
    await svc.keys.create(actor, project.id, { name: "gone", baseValue: "Gone" });
    await svc.translations.set(actor, project.id, "fr", { name: "keep", value: "Garder", status: "approved" });
    await svc.translations.set(actor, project.id, "fr", { name: "gone", value: "Parti", status: "approved" });
    // Deprecate `gone` by re-importing only `keep` with deprecate-absent.
    await svc.keys.import(actor, project.id, [{ name: "keep" }], undefined, { deprecateAbsent: true });

    const paged = await svc.translations.exportBundlePage(actor, project.id, "fr", { limit: 50 });
    expect(paged.entries.map((e) => e.key)).toEqual(["keep"]);
  });

  it("paginates the growth lists, matching the whole-list result", async () => {
    const { repo, svc } = setup();
    const { actor } = await ownerActor(repo, svc);
    const project = await svc.projects.create(actor, { name: "App", baseLocale: "en" });
    await svc.locales.add(actor, project.id, "fr");
    // 5 keys; translate the even ones in fr so 3 stay untranslated.
    for (let i = 0; i < 5; i++) {
      await svc.keys.create(actor, project.id, { name: `k${i}`, baseValue: `Base${i}` });
      if (i % 2 === 0) {
        await svc.translations.set(actor, project.id, "fr", { name: `k${i}`, value: `Fr${i}` });
      }
    }

    // Drains every page of a key-list page method at the given limit.
    const drain = async (
      fetch: (cursor?: string) => Promise<{ keys: { name: string }[]; nextCursor?: string }>,
    ): Promise<{ names: string[]; pages: number }> => {
      const names: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await fetch(cursor);
        names.push(...page.keys.map((k) => k.name));
        cursor = page.nextCursor;
        pages++;
      } while (cursor && pages < 20);
      return { names, pages };
    };

    // search_keys: the paged walk (filter within each page) equals the whole search.
    const whole = (await svc.keys.search(actor, project.id, "k")).map((k) => k.name).sort();
    const search = await drain((cursor) =>
      svc.keys.searchPage(actor, project.id, "k", { limit: 2, cursor }),
    );
    expect(search.pages).toBe(3); // 5 keys at 2/page → pages over the key partition
    expect(search.names.sort()).toEqual(whole);

    // list_untranslated: the paged walk equals the whole untranslated list (k1, k3).
    const untranslated = await drain((cursor) =>
      svc.translations.listUntranslatedPage(actor, project.id, "fr", { limit: 2, cursor }),
    );
    expect(untranslated.names.sort()).toEqual(["k1", "k3"]);
    expect(untranslated.pages).toBe(3); // pages bound to keys scanned, not matches
  });

  it("paginates list_stale and treats the base locale as never stale", async () => {
    const { repo, svc } = setup();
    const { actor } = await ownerActor(repo, svc);
    const project = await svc.projects.create(actor, { name: "App", baseLocale: "en" });
    await svc.locales.add(actor, project.id, "fr");
    await svc.keys.create(actor, project.id, { name: "k0", baseValue: "Base0" });
    await svc.keys.create(actor, project.id, { name: "k1", baseValue: "Base1" });
    await svc.translations.set(actor, project.id, "fr", { name: "k0", value: "Fr0" });
    await svc.translations.set(actor, project.id, "fr", { name: "k1", value: "Fr1" });
    // Move the source of k0 on, so its fr translation is now stale.
    await svc.translations.set(actor, project.id, "en", { name: "k0", value: "Base0 v2" });

    const whole = (await svc.translations.listStale(actor, project.id, "fr")).map((k) => k.name);
    expect(whole).toEqual(["k0"]);
    const firstPage = await svc.translations.listStalePage(actor, project.id, "fr", { limit: 50 });
    expect(firstPage.keys.map((k) => k.name)).toEqual(["k0"]);
    // The base locale is the source — never stale, even paged.
    const base = await svc.translations.listStalePage(actor, project.id, "en", { limit: 50 });
    expect(base.keys).toEqual([]);
    expect(base.nextCursor).toBeUndefined();
  });

  it("requires confirm to delete a key and its translations", async () => {
    const { repo, svc } = setup();
    const { actor } = await ownerActor(repo, svc);
    const project = await svc.projects.create(actor, { name: "App", baseLocale: "en" });
    await svc.locales.add(actor, project.id, "fr");
    await svc.keys.create(actor, project.id, { name: "doomed", baseValue: "Bye" });
    await svc.translations.set(actor, project.id, "fr", { name: "doomed", value: "Adieu" });

    // Without confirm the cascade is refused and nothing is removed.
    await expect(svc.keys.delete(actor, project.id, "doomed", false)).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect((await svc.keys.list(actor, project.id)).map((k) => k.name)).toEqual(["doomed"]);

    // With confirm the key and its translations are gone.
    await svc.keys.delete(actor, project.id, "doomed", true);
    expect(await svc.keys.list(actor, project.id)).toEqual([]);
    expect(await svc.translations.listForKey(actor, project.id, "doomed")).toHaveLength(0);
  });

  it("rejects an expired API key", async () => {
    const { repo, svc } = setup();
    const { actor } = await ownerActor(repo, svc);
    const future = new Date(Date.now() + 60_000).toISOString();
    const { apiKey, secret } = await svc.apiKeys.create(actor, { name: "temp", expiresAt: future });
    // A live key authenticates...
    expect(await authenticate(repo as unknown as Repository, secret)).toBeTruthy();
    // ...but once expired it is indistinguishable from an unknown key.
    repo.apiKeys.get(apiKey.hash)!.expiresAt = new Date(Date.now() - 1000).toISOString();
    expect(await authenticate(repo as unknown as Repository, secret)).toBeUndefined();
  });

  it("validates the expiresAt on key creation", async () => {
    const { repo, svc } = setup();
    const { actor } = await ownerActor(repo, svc);
    await expect(svc.apiKeys.create(actor, { name: "k", expiresAt: "not-a-date" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(
      svc.apiKeys.create(actor, { name: "k", expiresAt: new Date(Date.now() - 1000).toISOString() }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("a read-only API key may read but not mutate, regardless of role", async () => {
    const { repo, svc } = setup();
    const { actor: owner } = await ownerActor(repo, svc);
    const project = await svc.projects.create(owner, { name: "App", baseLocale: "en" });
    await svc.keys.create(owner, project.id, { name: "greeting", baseValue: "Hello" });

    // Mint a read-only key for the OWNER (who otherwise acts as MANAGER everywhere).
    const { secret } = await svc.apiKeys.create(owner, { name: "ci", readOnly: true });
    const ro = (await authenticate(repo as unknown as Repository, secret))!.actor;
    expect(ro.readOnly).toBe(true);

    // Reads are allowed (project- and org-scoped)...
    await expect(svc.keys.list(ro, project.id)).resolves.toBeDefined();
    await expect(svc.projects.list(ro)).resolves.toBeDefined();
    // ...but every mutation is forbidden, even though the user is an OWNER.
    await expect(svc.keys.create(ro, project.id, { name: "x" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      svc.projects.create(ro, { name: "Nope", baseLocale: "en" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("delivers only approved values, with source fallback and a working override", async () => {
    const { repo, svc } = setup();
    const { actor } = await ownerActor(repo, svc);
    const project = await svc.projects.create(actor, { name: "App", baseLocale: "en" });
    await svc.locales.add(actor, project.id, "fr");
    await svc.keys.create(actor, project.id, { name: "greeting", baseValue: "Hello" });

    const bundle = (
      code: string,
      opts?: { slot?: "approved" | "working"; fallback?: "source" | "omit" },
    ) =>
      svc.translations
        .exportBundle(actor, project.id, code, opts)
        .then((b) => Object.fromEntries(b.map((e) => [e.key, e.value])));

    // A working (unapproved) translation must not ship; pull falls back to source.
    await svc.translations.set(actor, project.id, "fr", { name: "greeting", value: "Bonjour" });
    expect(await bundle("fr")).toEqual({ greeting: "Hello" });
    expect(await bundle("fr", { fallback: "omit" })).toEqual({});
    expect(await bundle("fr", { slot: "working" })).toEqual({ greeting: "Bonjour" });

    // Approval promotes the working value into the shipped snapshot.
    await svc.translations.setStatus(actor, project.id, "fr", "greeting", "approved");
    expect(await bundle("fr")).toEqual({ greeting: "Bonjour" });

    // Editing after approval keeps shipping the last approved value (no leak)...
    await svc.translations.set(actor, project.id, "fr", { name: "greeting", value: "Salut" });
    expect(await bundle("fr")).toEqual({ greeting: "Bonjour" });
    expect(await bundle("fr", { slot: "working" })).toEqual({ greeting: "Salut" });
    const fr = (await svc.translations.listForKey(actor, project.id, "greeting")).find(
      (t) => t.localeCode === "fr",
    );
    // ...status dropped back to translated; the approved snapshot is retained.
    expect(fr).toMatchObject({ status: "translated", value: "Salut", approvedValue: "Bonjour" });

    // The base locale always ships its own source value.
    expect(await bundle("en")).toEqual({ greeting: "Hello" });
  });

  it("bulk-set promotes approved entries and preserves prior approved snapshots", async () => {
    const { repo, svc } = setup();
    const { actor } = await ownerActor(repo, svc);
    const project = await svc.projects.create(actor, { name: "App", baseLocale: "en" });
    await svc.locales.add(actor, project.id, "fr");
    await svc.keys.create(actor, project.id, { name: "a", baseValue: "A" });
    await svc.keys.create(actor, project.id, { name: "b", baseValue: "B" });

    await svc.translations.bulkSet(actor, project.id, "fr", [
      { name: "a", value: "Aa", status: "approved" },
      { name: "b", value: "Bb" },
    ]);
    const after = async (key: string) =>
      (await svc.translations.listForLocale(actor, project.id, "fr")).find((t) => t.keyName === key);
    expect(await after("a")).toMatchObject({ status: "approved", approvedValue: "Aa" });
    expect(await after("b")).toMatchObject({ status: "translated", approvedValue: undefined });

    // A later working edit to b leaves a's approved snapshot untouched.
    await svc.translations.bulkSet(actor, project.id, "fr", [{ name: "b", value: "Bbb" }]);
    expect(await after("a")).toMatchObject({ status: "approved", approvedValue: "Aa" });
  });

  it("flags translations stale when the source value moves on", async () => {
    const { repo, svc } = setup();
    const { actor } = await ownerActor(repo, svc);
    const project = await svc.projects.create(actor, { name: "App", baseLocale: "en" });
    await svc.locales.add(actor, project.id, "fr");
    await svc.keys.create(actor, project.id, { name: "greeting", baseValue: "Hello" });

    const staleNames = async () =>
      (await svc.translations.listStale(actor, project.id, "fr")).map((k) => k.name);

    // Translated against the current source -> not stale.
    await svc.translations.set(actor, project.id, "fr", { name: "greeting", value: "Bonjour" });
    expect(await staleNames()).toEqual([]);

    // The source value changes (a developer push) -> the fr value is now stale.
    await svc.keys.import(actor, project.id, [{ name: "greeting", baseValue: "Howdy" }]);
    expect(await staleNames()).toEqual(["greeting"]);
    // ...and `excludeStale` drops it from the export bundle.
    expect(
      await svc.translations.exportBundle(actor, project.id, "fr", { excludeStale: true }),
    ).toEqual([]);

    // Re-translating against the new source clears staleness...
    await svc.translations.set(actor, project.id, "fr", { name: "greeting", value: "Salut" });
    expect(await staleNames()).toEqual([]);
    // ...and the base locale (the source) is never stale.
    expect(await svc.translations.listStale(actor, project.id, "en")).toEqual([]);
  });

  it("runs QA checks, flags a placeholder mismatch, and skips deprecated keys", async () => {
    const { repo, svc } = setup();
    const { actor } = await ownerActor(repo, svc);
    const project = await svc.projects.create(actor, { name: "App", baseLocale: "en" });
    await svc.locales.add(actor, project.id, "fr");
    await svc.keys.create(actor, project.id, { name: "greeting", baseValue: "Hi {name}" });
    await svc.keys.create(actor, project.id, { name: "gone", baseValue: "Old {x}" });
    // A target that drops the {name} placeholder -> error.
    await svc.translations.set(actor, project.id, "fr", { name: "greeting", value: "Salut" });
    await svc.translations.set(actor, project.id, "fr", { name: "gone", value: "Vieux" });
    // Deprecate the second key; its findings must not appear.
    await svc.keys.import(actor, project.id, [{ name: "greeting", baseValue: "Hi {name}" }], "default", {
      deprecateAbsent: true,
    });

    const report = await svc.qa.run(actor, project.id, { locale: "fr" });
    expect(report.counts.error).toBeGreaterThanOrEqual(1);
    expect(report.findings.some((f) => f.checkId === "placeholders" && f.keyName === "greeting")).toBe(true);
    expect(report.findings.some((f) => f.keyName === "gone")).toBe(false);
  });

  it("honours config: disable a check, override severity, and ignore rules", async () => {
    const { repo, svc } = setup();
    const { actor } = await ownerActor(repo, svc);
    const project = await svc.projects.create(actor, { name: "App", baseLocale: "en" });
    await svc.locales.add(actor, project.id, "fr");
    await svc.keys.create(actor, project.id, { name: "greeting", baseValue: "Hi {name}" });
    await svc.translations.set(actor, project.id, "fr", { name: "greeting", value: "Salut" });

    const base = await svc.qa.run(actor, project.id, { locale: "fr" });
    expect(base.findings.some((f) => f.checkId === "placeholders")).toBe(true);

    // Disabling the check removes its findings.
    await svc.qa.setConfig(actor, project.id, { checks: { placeholders: { enabled: false } } });
    const disabled = await svc.qa.run(actor, project.id, { locale: "fr" });
    expect(disabled.findings.some((f) => f.checkId === "placeholders")).toBe(false);

    // Re-enable but downgrade to a warning.
    await svc.qa.setConfig(actor, project.id, { checks: { placeholders: { enabled: true, severity: "warning" } } });
    const downgraded = await svc.qa.run(actor, project.id, { locale: "fr" });
    const ph = downgraded.findings.find((f) => f.checkId === "placeholders");
    expect(ph?.severity).toBe("warning");

    // An ignore rule mutes it entirely.
    await svc.qa.setConfig(actor, project.id, {
      checks: { placeholders: { enabled: true, severity: "warning" } },
      ignore: [{ checkId: "placeholders", keyName: "greeting" }],
    });
    const ignored = await svc.qa.run(actor, project.id, { locale: "fr" });
    expect(ignored.findings.some((f) => f.checkId === "placeholders")).toBe(false);
  });

  it("rejects unknown check ids and unknown locales; an empty ignore rule is invalid", async () => {
    const { repo, svc } = setup();
    const { actor } = await ownerActor(repo, svc);
    const project = await svc.projects.create(actor, { name: "App", baseLocale: "en" });
    await expect(svc.qa.run(actor, project.id, { checkIds: ["nope"] })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(svc.qa.run(actor, project.id, { locale: "zz" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(svc.qa.setConfig(actor, project.id, { ignore: [{}] })).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("lets a reader run checks but requires project.update to configure them", async () => {
    const { repo, svc } = setup();
    const { actor } = await ownerActor(repo, svc);
    const project = await svc.projects.create(actor, { name: "App", baseLocale: "en" });
    await svc.locales.add(actor, project.id, "fr");
    // An EDITOR has translation.read but not project.update.
    const member = await svc.users.create(actor, { email: "ed@acme.com", name: "Ed" });
    await svc.members.add(actor, project.id, { userId: member.id }, "EDITOR");
    const key = await svc.apiKeys.create(actor, { name: "k", userId: member.id });
    const editor = (await authenticate(repo as unknown as Repository, key.secret))!.actor;

    await expect(svc.qa.run(editor, project.id, { locale: "fr" })).resolves.toMatchObject({
      projectId: project.id,
    });
    await expect(
      svc.qa.setConfig(editor, project.id, { checks: { empty: { enabled: false } } }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
