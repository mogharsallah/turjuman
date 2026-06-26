import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authenticate, bootstrapOwner } from "./auth.js";
import { AppError, type Actor } from "@turjuman/schema";
import { Repository } from "./repository/index.js";
import { TurjumanService } from "./services/index.js";

/**
 * Full end-to-end test against a real DynamoDB (LocalStack). Skipped unless
 * AWS_ENDPOINT_URL_DYNAMODB is set, so the default unit run stays hermetic.
 *
 *   npm run localstack:up
 *   AWS_ENDPOINT_URL_DYNAMODB=http://localhost:4566 AWS_ACCESS_KEY_ID=local \
 *   AWS_SECRET_ACCESS_KEY=local AWS_REGION=us-east-1 TURJUMAN_TABLE=TurjumanTest \
 *   npx vitest run integration
 */
const endpoint = process.env.AWS_ENDPOINT_URL_DYNAMODB;
const TABLE = process.env.TURJUMAN_TABLE ?? "TurjumanTest";

const client = new DynamoDBClient({
  endpoint,
  region: process.env.AWS_REGION ?? "us-east-1",
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
});
const repo = new Repository({ tableName: TABLE, client });
const svc = new TurjumanService(repo);

async function createTable(): Promise<void> {
  await client.send(new DeleteTableCommand({ TableName: TABLE })).catch(() => undefined);
  const gsi = (n: string) => ({
    IndexName: n,
    KeySchema: [
      { AttributeName: `${n}PK`, KeyType: "HASH" as const },
      { AttributeName: `${n}SK`, KeyType: "RANGE" as const },
    ],
    Projection: { ProjectionType: "ALL" as const },
  });
  await client.send(
    new CreateTableCommand({
      TableName: TABLE,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: ["PK", "SK", "GSI1PK", "GSI1SK", "GSI2PK", "GSI2SK", "GSI3PK", "GSI3SK"].map(
        (n) => ({ AttributeName: n, AttributeType: "S" as const }),
      ),
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
      GlobalSecondaryIndexes: [gsi("GSI1"), gsi("GSI2"), gsi("GSI3")],
    }),
  );
  await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: TABLE });
}

describe.skipIf(!endpoint)("end-to-end against DynamoDB", () => {
  beforeAll(createTable, 60_000);
  afterAll(async () => {
    await client.send(new DeleteTableCommand({ TableName: TABLE })).catch(() => undefined);
  });

  it("runs the full translation lifecycle with RBAC and tenant isolation", async () => {
    // --- bootstrap owner + auth ---
    const boot = await bootstrapOwner(repo, { email: "owner@acme.com", name: "Owner" });
    const ownerAuth = await authenticate(repo, boot.secret);
    expect(ownerAuth?.actor.globalRole).toBe("OWNER");
    const owner = ownerAuth!.actor;

    // --- project + locales ---
    const project = await svc.projects.create(owner, { name: "Web App", baseLocale: "en" });
    expect(project.baseLocale).toBe("en");
    await svc.locales.add(owner, project.id, "fr");
    await svc.locales.add(owner, project.id, "es");
    expect((await svc.locales.list(owner, project.id)).map((l) => l.code).sort()).toEqual([
      "en",
      "es",
      "fr",
    ]);

    // --- keys with base values ---
    await svc.keys.create(owner, project.id, {
      name: "app.title",
      description: "Product name in the header",
      baseValue: "Turjuman",
    });
    await svc.keys.create(owner, project.id, { name: "greeting", baseValue: "Hello" });

    // --- untranslated discovery + bulk fill (the LLM flow) ---
    const before = await svc.translations.listUntranslated(owner, project.id, "fr");
    expect(before.map((k) => k.name).sort()).toEqual(["app.title", "greeting"]);
    const bulk = await svc.translations.bulkSet(owner, project.id, "fr", [
      { name: "app.title", value: "Turjuman" },
      { name: "greeting", value: "Bonjour" },
      { name: "ghost", value: "nope" }, // unknown key -> skipped
    ]);
    expect(bulk.written).toBe(2);
    expect(bulk.skipped).toEqual(["default#ghost"]);
    expect(await svc.translations.listUntranslated(owner, project.id, "fr")).toHaveLength(0);

    // --- GSI3: one key across locales (en base + fr) ---
    const greetingTranslations = await svc.translations.listForKey(owner, project.id, "greeting");
    expect(greetingTranslations.map((t) => t.localeCode).sort()).toEqual(["en", "fr"]);

    // --- review workflow: approving promotes the working value into approvedValue ---
    const approved = await svc.translations.setStatus(owner, project.id, "fr", "greeting", "approved");
    expect(approved.status).toBe("approved");
    expect(approved.approvedValue).toBe(approved.value);

    // --- RBAC: a VIEWER can read but not write ---
    const viewer = await svc.users.create(owner, { email: "viewer@acme.com", name: "Vee" });
    await svc.members.add(owner, project.id, { userId: viewer.id }, "VIEWER");
    const viewerKey = await svc.apiKeys.create(owner, { name: "vk", userId: viewer.id });
    const viewerActor = (await authenticate(repo, viewerKey.secret))!.actor;

    expect((await svc.projects.list(viewerActor)).map((p) => p.id)).toContain(project.id);
    await expect(svc.translations.listForLocale(viewerActor, project.id, "fr")).resolves.toHaveLength(2);
    await expect(
      svc.translations.set(viewerActor, project.id, "fr", { name: "greeting", value: "x" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      svc.members.add(viewerActor, project.id, { email: "owner@acme.com" }, "VIEWER"),
    ).rejects.toBeInstanceOf(AppError);

    // --- CLI path: importKeys then export ---
    const imported = await svc.keys.import(
      owner,
      project.id,
      [
        { name: "nav.home", baseValue: "Home" },
        { name: "app.title", baseValue: "Turjuman" }, // existing key, no-op create
      ],
      "default",
    );
    expect(imported.created).toBe(1);
    expect(imported.baseValuesSet).toBe(2);
    const enExport = await svc.translations.listForLocale(owner, project.id, "en");
    expect(enExport.map((t) => t.keyName).sort()).toEqual(["app.title", "greeting", "nav.home"]);

    // --- glossary CRUD ---
    const term = await svc.glossary.add(owner, project.id, {
      term: "Turjuman",
      doNotTranslate: true,
      notes: "Brand name",
    });
    expect((await svc.glossary.list(owner, project.id)).map((t) => t.term)).toEqual(["Turjuman"]);
    const renamed = await svc.glossary.update(owner, project.id, term.id, {
      translations: { fr: "Turjuman" },
    });
    expect(renamed.translations).toEqual({ fr: "Turjuman" });
    await svc.glossary.remove(owner, project.id, term.id);
    expect(await svc.glossary.list(owner, project.id)).toHaveLength(0);
    // VIEWER may read the glossary but not manage it.
    await expect(svc.glossary.list(viewerActor, project.id)).resolves.toEqual([]);
    await expect(
      svc.glossary.add(viewerActor, project.id, { term: "x" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // --- translation memory (derived): "Hello" -> "Bonjour" via the greeting key ---
    const tm = await svc.tm.lookup(owner, project.id, "fr", "Hello");
    expect(tm[0]).toMatchObject({ source: "Hello", target: "Bonjour", score: 1 });

    // --- webhooks ---
    const webhook = await svc.webhooks.add(owner, project.id, {
      url: "https://example.com/hook",
      events: ["translation.updated"],
    });
    expect(webhook.secret).toMatch(/^whsec_/);
    expect(await svc.webhooks.list(owner, project.id)).toHaveLength(1);
    await svc.webhooks.remove(owner, project.id, webhook.id);
    expect(await svc.webhooks.list(owner, project.id)).toHaveLength(0);
    await expect(svc.webhooks.list(viewerActor, project.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    // --- project deletion cascade (on a throwaway project) ---
    const doomed = await svc.projects.create(owner, { name: "Doomed", baseLocale: "en" });
    await svc.locales.add(owner, doomed.id, "fr");
    await svc.keys.create(owner, doomed.id, { name: "temp.key", baseValue: "x" });
    await svc.glossary.add(owner, doomed.id, { term: "X" });
    await expect(svc.projects.delete(owner, doomed.id, false)).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await svc.projects.delete(owner, doomed.id, true);
    expect(await repo.getProject(doomed.id)).toBeUndefined();
    expect(await repo.listKeys(doomed.id)).toHaveLength(0);
    expect(await repo.listLocales(doomed.id)).toHaveLength(0);
    expect(await repo.listGlossary(doomed.id)).toHaveLength(0);
    expect(await repo.listTranslationsByLocale(doomed.id, "en")).toHaveLength(0);

    // --- API key revocation: a revoked key no longer authenticates ---
    const throwaway = await svc.apiKeys.create(owner, { name: "throwaway", userId: viewer.id });
    expect(await authenticate(repo, throwaway.secret)).toBeTruthy();
    await svc.apiKeys.revoke(owner, throwaway.apiKey.id, viewer.id);
    expect(await authenticate(repo, throwaway.secret)).toBeUndefined();
    // The viewer may revoke their own remaining key, but not someone else's.
    await expect(
      svc.apiKeys.revoke(viewerActor, "key_does_not_exist"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // --- add_member auto-provisions an unknown email for an admin ---
    const provisioned = await svc.members.add(
      owner,
      project.id,
      { email: "newbie@acme.com", name: "Newbie" },
      "EDITOR",
    );
    expect(provisioned.role).toBe("EDITOR");
    expect((await svc.users.list(owner)).map((u) => u.email)).toContain("newbie@acme.com");

    // --- importKeys --prune removes keys absent from the source set ---
    const pruneProject = await svc.projects.create(owner, { name: "Prune", baseLocale: "en" });
    await svc.keys.import(owner, pruneProject.id, [
      { name: "keep.me", baseValue: "Keep" },
      { name: "drop.me", baseValue: "Drop" },
    ]);
    const pruned = await svc.keys.import(
      owner,
      pruneProject.id,
      [{ name: "keep.me", baseValue: "Keep" }],
      "default",
      { prune: true },
    );
    expect(pruned.deleted).toBe(1);
    expect((await repo.listKeys(pruneProject.id)).map((k) => k.name)).toEqual(["keep.me"]);

    // --- list_keys pagination walks the full set via the cursor ---
    for (let i = 0; i < 5; i++) {
      await svc.keys.create(owner, pruneProject.id, { name: `page.k${i}` });
    }
    const seenNames = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await svc.keys.listPage(owner, pruneProject.id, { limit: 2, cursor });
      page.keys.forEach((k) => seenNames.add(k.name));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 20);
    expect(seenNames.size).toBe(6); // keep.me + 5 page.k*

    // --- bootstrap guard: refuses a second owner in a populated org ---
    await expect(bootstrapOwner(repo, { email: "second@acme.com", name: "Second" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const forced = await bootstrapOwner(repo, {
      email: "second@acme.com",
      name: "Second",
      force: true,
    });
    expect(forced.user.globalRole).toBe("OWNER");

    // --- tenant isolation: a different org cannot see this project ---
    const other = await bootstrapOwner(repo, {
      email: "owner@other.com",
      name: "Other",
      orgId: "other",
    });
    const otherActor = (await authenticate(repo, other.secret))!.actor;
    expect(await svc.projects.list(otherActor)).toHaveLength(0);
    await expect(svc.projects.get(otherActor, project.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  }, 60_000);
});

/**
 * Focused single-table invariants against real DynamoDB — the properties that the
 * in-memory fake can only approximate: the transacted email-uniqueness companion
 * item, GSI partitioning (org isolation on GSI1, by-key fan-out on GSI3), and
 * cursor continuity (no duplicates, no gaps) on a real paginated Query. Each runs
 * on its own freshly-created table so it doesn't depend on the lifecycle test
 * above. Skipped with the same env guard, so the default unit run stays hermetic.
 */
describe.skipIf(!endpoint)("single-table invariants (DynamoDB)", () => {
  let owner: Actor;
  beforeAll(async () => {
    await createTable();
    const boot = await bootstrapOwner(repo, { email: "inv-owner@acme.com", name: "Inv Owner" });
    owner = (await authenticate(repo, boot.secret))!.actor;
  }, 60_000);
  afterAll(async () => {
    await client.send(new DeleteTableCommand({ TableName: TABLE })).catch(() => undefined);
  });

  it("enforces email uniqueness atomically via the transacted companion item", async () => {
    const a = await svc.users.create(owner, { email: "dup@acme.com", name: "A" });
    // The second create fails the companion item's attribute_not_exists condition,
    // so the whole TransactWrite rolls back — no orphan user, no second email item.
    await expect(svc.users.create(owner, { email: "dup@acme.com", name: "B" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    // A case variant collides too: the email index key is lower-cased.
    await expect(svc.users.create(owner, { email: "DUP@acme.com", name: "C" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    // Exactly one user holds the email, and it is the first one (no partial write).
    expect((await repo.getUserByEmail("dup@acme.com"))?.id).toBe(a.id);
    expect(
      (await repo.listUsersByOrg(owner.orgId)).filter((u) => u.email === "dup@acme.com"),
    ).toHaveLength(1);
  });

  it("partitions GSI1 by org and fans out GSI3 by key", async () => {
    // GSI1 ("by org"): a project created in another org never appears in this org's
    // query, and vice-versa — the GSI1PK is the org, so the partitions are disjoint.
    const mine = await svc.projects.create(owner, { name: "Mine", baseLocale: "en" });
    const otherBoot = await bootstrapOwner(repo, {
      email: "gsi-other@acme.com",
      name: "Other",
      orgId: "gsi-other-org",
    });
    const otherActor = (await authenticate(repo, otherBoot.secret))!.actor;
    const theirs = await svc.projects.create(otherActor, { name: "Theirs", baseLocale: "en" });

    const myProjectIds = (await repo.listProjectsByOrg(owner.orgId)).map((p) => p.id);
    expect(myProjectIds).toContain(mine.id);
    expect(myProjectIds).not.toContain(theirs.id);
    expect((await repo.listProjectsByOrg("gsi-other-org")).map((p) => p.id)).toEqual([theirs.id]);

    // GSI3 ("by key"): one key's translations across every locale come back from a
    // single PK-only query on the key's GSI3PK.
    await svc.locales.add(owner, mine.id, "fr");
    await svc.locales.add(owner, mine.id, "es");
    await svc.keys.create(owner, mine.id, { name: "greeting", baseValue: "Hello" });
    await svc.translations.set(owner, mine.id, "fr", { name: "greeting", value: "Bonjour" });
    await svc.translations.set(owner, mine.id, "es", { name: "greeting", value: "Hola" });
    const byKey = await repo.listTranslationsByKey(mine.id, "default", "greeting");
    expect(byKey.map((t) => t.localeCode).sort()).toEqual(["en", "es", "fr"]);
  });

  it("walks the key partition by cursor with no duplicates and no gaps", async () => {
    const project = await svc.projects.create(owner, { name: "Paged", baseLocale: "en" });
    const total = 7;
    for (let i = 0; i < total; i++) {
      // Zero-padded so the lexical SK order is the obvious numeric order.
      await svc.keys.create(owner, project.id, { name: `k${String(i).padStart(2, "0")}` });
    }
    const whole = (await repo.listKeys(project.id)).map((k) => k.name);
    expect(whole).toHaveLength(total);

    // Page at a limit that doesn't divide the total, so the last page is partial.
    const limit = 3;
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await repo.listKeysPage(project.id, { limit, cursor });
      expect(page.keys.length).toBeLessThanOrEqual(limit);
      seen.push(...page.keys.map((k) => k.name));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 20);

    expect(pages).toBe(Math.ceil(total / limit)); // 3 pages: 3 + 3 + 1
    expect(new Set(seen).size).toBe(total); // no duplicates across page boundaries
    expect([...seen].sort()).toEqual([...whole].sort()); // no gaps: union == whole
  });
});
