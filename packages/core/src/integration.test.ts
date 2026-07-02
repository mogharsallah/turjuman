import {
	CreateTableCommand,
	DeleteTableCommand,
	DynamoDBClient,
	waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import { type Actor, MAIN_BRANCH_ID } from "@turjuman/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authenticate, bootstrapOwner } from "./auth.js";
import { Repository } from "./repository/index.js";
import { TurjumanService } from "./services/index.js";

/**
 * The rebuilt cell/branch/version model exercised against a **real** DynamoDB
 * (LocalStack) — the tier the in-memory {@link FakeRepo} can only approximate.
 * It proves the properties that live in DynamoDB itself, not in TypeScript: the
 * single-table key scheme round-trips (writes land where the mappers read),
 * `acceptCell`'s `head` compare-and-swap and the transacted uniqueness items are
 * enforced by real conditional writes, GSI1/GSI3 partition as designed (GSI3 now
 * carries the branch segment), copy-on-write reads fall through across real
 * partitions, and a release reassembles from its split META + entry partitions.
 *
 * Skipped unless AWS_ENDPOINT_URL_DYNAMODB is set, so the default unit run stays
 * hermetic:
 *
 *   pnpm run localstack:up
 *   pnpm run test:integration          # (self-skips when the env var is unset)
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
	await client
		.send(new DeleteTableCommand({ TableName: TABLE }))
		.catch(() => undefined);
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
			AttributeDefinitions: [
				"PK",
				"SK",
				"GSI1PK",
				"GSI1SK",
				"GSI2PK",
				"GSI2SK",
				"GSI3PK",
				"GSI3SK",
			].map((n) => ({ AttributeName: n, AttributeType: "S" as const })),
			KeySchema: [
				{ AttributeName: "PK", KeyType: "HASH" },
				{ AttributeName: "SK", KeyType: "RANGE" },
			],
			GlobalSecondaryIndexes: [gsi("GSI1"), gsi("GSI2"), gsi("GSI3")],
		}),
	);
	await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: TABLE });
}

const dropTable = () =>
	client
		.send(new DeleteTableCommand({ TableName: TABLE }))
		.catch(() => undefined);

/** Fresh project (base locale `en`) with the given target locales added. */
async function newProject(
	owner: Actor,
	name: string,
	locales: string[] = ["fr"],
) {
	const project = await svc.projects.create(owner, { name, baseLocale: "en" });
	for (const code of locales) await svc.locales.add(owner, project.id, code);
	return project;
}

describe.skipIf(!endpoint)("the rebuilt model against real DynamoDB", () => {
	let owner: Actor;
	beforeAll(async () => {
		await createTable();
		const boot = await bootstrapOwner(repo, {
			email: "owner@acme.com",
			name: "Owner",
		});
		const auth = await authenticate(repo, boot.secret);
		expect(auth?.actor.globalRole).toBe("OWNER");
		owner = auth!.actor;
	}, 60_000);
	afterAll(dropTable);

	it("stands up a project with an auto-created main branch and locales", async () => {
		const project = await svc.projects.create(owner, {
			name: "Web App",
			baseLocale: "en",
		});
		expect(project.baseLocale).toBe("en");
		expect(project.contextRevision).toBe(0);
		expect(project.requireHumanAccept).toBe(false);

		const branches = await svc.branches.list(owner, project.id);
		expect(branches.map((b) => b.id)).toEqual([MAIN_BRANCH_ID]);
		expect(branches[0]?.parentBranchId).toBeNull();

		await svc.locales.add(owner, project.id, "fr");
		await svc.locales.add(owner, project.id, "es");
		expect(
			(await svc.locales.list(owner, project.id)).map((l) => l.code).sort(),
		).toEqual(["en", "es", "fr"]);
	});

	it("runs the agent loop: discover, bulk-fill, accept, export", async () => {
		const project = await newProject(owner, "Loop", ["fr"]);
		await svc.keys.create(owner, project.id, { name: "a", baseValue: "Hello" });
		await svc.keys.create(owner, project.id, { name: "b", baseValue: "World" });

		// discover the gaps
		const before = await svc.translations.listUntranslated(
			owner,
			project.id,
			"fr",
		);
		expect(before.map((k) => k.name).sort()).toEqual(["a", "b"]);

		// bulk-fill (the agent proposing); an unknown key is skipped, not created
		const bulk = await svc.translations.bulkSet(owner, project.id, "fr", [
			{ name: "a", value: "Bonjour" },
			{ name: "b", value: "Monde" },
			{ name: "ghost", value: "nope" },
		]);
		expect(bulk.written).toBe(2);
		expect(bulk.skipped.some((s) => s.includes("ghost"))).toBe(true);
		expect(
			await svc.translations.listUntranslated(owner, project.id, "fr"),
		).toHaveLength(0);

		// accept only `a` — it moves proposed → accepted with a version chain
		const accepted = await svc.translations.accept(
			owner,
			project.id,
			"fr",
			"a",
		);
		expect(accepted.lifecycle).toBe("accepted");
		expect(accepted.head).toBe(1);
		const history = await repo.getCellHistory(
			project.id,
			MAIN_BRANCH_ID,
			accepted.keyId,
			"fr",
		);
		expect(history.map((v) => v.value)).toEqual(["Bonjour"]);

		// GSI3: one key's cells across every locale come back from one query
		const aCells = await svc.translations.listForKey(owner, project.id, "a");
		expect(aCells.map((c) => c.locale).sort()).toEqual(["en", "fr"]);

		// export ships the accepted value and falls back to source for un-accepted `b`
		const bundle = await svc.translations.exportBundle(owner, project.id, "fr");
		const byKey = new Map(bundle.map((e) => [e.key, e.value]));
		expect(byKey.get("a")).toBe("Bonjour");
		expect(byKey.get("b")).toBe("World");
	});

	it("falls through to main across partitions, then merges back with no budget", async () => {
		const project = await newProject(owner, "Merge", ["fr"]);
		const key = await svc.keys.create(owner, project.id, {
			name: "greeting",
			baseValue: "Hello",
		});
		// main gets an accepted value BEFORE the fork
		await svc.translations.set(owner, project.id, "fr", {
			name: "greeting",
			value: "Bonjour",
		});
		await svc.translations.accept(owner, project.id, "fr", "greeting");

		const branch = await svc.branches.create(owner, project.id, {
			name: "feature",
		});
		expect(branch.parentBranchId).toBe(MAIN_BRANCH_ID);
		// unwritten on the branch → resolves through to main's cell (cross-partition)
		expect(
			(await repo.getCell(project.id, branch.id, key.id, "fr"))?.value,
		).toBe("Bonjour");

		// the branch overrides; main stays isolated
		await svc.translations.set(owner, project.id, "fr", {
			name: "greeting",
			value: "Salut",
			branch: branch.id,
		});
		await svc.translations.accept(owner, project.id, "fr", "greeting", {
			branch: branch.id,
		});
		expect(
			(await repo.getCell(project.id, branch.id, key.id, "fr"))?.value,
		).toBe("Salut");
		expect(
			(await repo.getCell(project.id, MAIN_BRANCH_ID, key.id, "fr"))?.value,
		).toBe("Bonjour");

		// main was never advanced past the fork point → a clean, budget-free merge
		const result = await svc.branches.merge(owner, project.id, branch.id);
		expect(result.merged).toBe(1);
		expect(result.conflicts).toHaveLength(0);
		expect(result.run.trigger).toBe("merge");
		expect(result.run.valueSource).toBe(`branch:${branch.id}`);
		expect(result.run.budgetSpent).toBe(0);
		expect(result.run.status).toBe("done");
		expect(
			(await repo.getCell(project.id, MAIN_BRANCH_ID, key.id, "fr"))?.value,
		).toBe("Salut");
		expect((await svc.branches.get(owner, project.id, branch.id)).status).toBe(
			"merged",
		);
	});

	it("holds a conflicting merge back as an escalation", async () => {
		const project = await newProject(owner, "Conflict", ["fr"]);
		const key = await svc.keys.create(owner, project.id, {
			name: "greeting",
			baseValue: "Hello",
		});
		await svc.translations.set(owner, project.id, "fr", {
			name: "greeting",
			value: "MainFr",
		});
		await svc.translations.accept(owner, project.id, "fr", "greeting");

		const branch = await svc.branches.create(owner, project.id, {
			name: "feature",
		});
		await svc.translations.set(owner, project.id, "fr", {
			name: "greeting",
			value: "BranchFr",
			branch: branch.id,
		});
		await svc.translations.accept(owner, project.id, "fr", "greeting", {
			branch: branch.id,
		});

		// main advances the SAME cell after the fork point (real wall-clock ordering)
		await svc.translations.set(owner, project.id, "fr", {
			name: "greeting",
			value: "MainFr2",
		});
		await svc.translations.accept(owner, project.id, "fr", "greeting");

		const result = await svc.branches.merge(owner, project.id, branch.id);
		expect(result.merged).toBe(0);
		expect(result.conflicts).toHaveLength(1);
		expect(result.conflicts[0]?.keyId).toBe(key.id);
		expect(result.run.status).toBe("partial");
		// main keeps its own value — the branch never overwrote it
		expect(
			(await repo.getCell(project.id, MAIN_BRANCH_ID, key.id, "fr"))?.value,
		).toBe("MainFr2");
		// the conflict is surfaced as a normal open escalation
		expect(
			await svc.escalations.list(owner, project.id, { status: "open" }),
		).toHaveLength(1);
	});

	it("cuts an immutable release that pins accepted versions and supersedes", async () => {
		const project = await newProject(owner, "Release", ["fr"]);
		const key = await svc.keys.create(owner, project.id, {
			name: "greeting",
			baseValue: "Hello",
		});
		await svc.translations.set(owner, project.id, "fr", {
			name: "greeting",
			value: "Bonjour",
		});
		await svc.translations.accept(owner, project.id, "fr", "greeting");

		const r1 = await svc.releases.create(owner, project.id, {
			label: "v1",
			locales: ["fr"],
		});
		expect(r1.status).toBe("open");
		expect(r1.entries).toEqual([
			{ keyId: key.id, locale: "fr", versionRef: 1 },
		]);

		// cutting a newer release supersedes the prior open one on the same branch
		const r2 = await svc.releases.create(owner, project.id, {
			label: "v2",
			locales: ["fr"],
		});
		const list = await svc.releases.list(owner, project.id);
		expect(list.find((r) => r.id === r1.id)?.status).toBe("superseded");
		expect(list.find((r) => r.id === r2.id)?.status).toBe("open");
		// the list view omits entries; get reassembles them from the entry partition
		expect(list.find((r) => r.id === r2.id)?.entries).toEqual([]);
		expect(
			(await svc.releases.get(owner, project.id, r2.id)).entries,
		).toHaveLength(1);

		// the superseded release is immutable — its pinned entries never change
		const r1After = await svc.releases.get(owner, project.id, r1.id);
		expect(r1After.entries).toEqual([
			{ keyId: key.id, locale: "fr", versionRef: 1 },
		]);
	});

	it("closes the production loop: a field report reopens a cell and compounds context", async () => {
		const project = await newProject(owner, "Field", ["fr"]);
		const key = await svc.keys.create(owner, project.id, {
			name: "greeting",
			baseValue: "Hello",
		});
		await svc.translations.set(owner, project.id, "fr", {
			name: "greeting",
			value: "Bonjour",
		});
		await svc.translations.accept(owner, project.id, "fr", "greeting");

		const report = await svc.fieldReports.file(owner, project.id, {
			locale: "fr",
			name: "greeting",
			description: "wrong tone",
		});
		expect(report.status).toBe("open");
		// the cell reopened (accepted → proposed) and is stale again
		const reopened = await repo.getCell(
			project.id,
			MAIN_BRANCH_ID,
			key.id,
			"fr",
		);
		expect(reopened?.lifecycle).toBe("proposed");
		expect(reopened?.stale).toBe(true);

		// a fix run re-accepts, then resolving spawns a gold example from the correction
		await svc.translations.set(owner, project.id, "fr", {
			name: "greeting",
			value: "Salut",
		});
		await svc.translations.accept(owner, project.id, "fr", "greeting");
		const resolved = await svc.fieldReports.resolve(
			owner,
			project.id,
			report.id,
			{ spawnExample: true },
		);
		expect(resolved.status).toBe("resolved");
		expect(resolved.resolution?.spawnedExampleRef).toMatch(/^ex_/);
		const examples = await svc.examples.find(
			owner,
			project.id,
			"fr",
			"greeting",
		);
		expect(examples.map((e) => e.targetText)).toContain("Salut");
	});

	it("enforces RBAC: a viewer reads but cannot write", async () => {
		const project = await newProject(owner, "Rbac", ["fr"]);
		await svc.keys.create(owner, project.id, {
			name: "greeting",
			baseValue: "Hello",
		});
		await svc.translations.set(owner, project.id, "fr", {
			name: "greeting",
			value: "Bonjour",
		});

		const viewer = await svc.users.create(owner, {
			email: "viewer@acme.com",
			name: "Vee",
		});
		await svc.members.add(owner, project.id, { userId: viewer.id }, "VIEWER");
		const viewerKey = await svc.apiKeys.create(owner, {
			name: "vk",
			userId: viewer.id,
		});
		const viewerActor = (await authenticate(repo, viewerKey.secret))!.actor;

		// reads succeed
		expect((await svc.projects.list(viewerActor)).map((p) => p.id)).toContain(
			project.id,
		);
		await expect(
			svc.translations.listForLocale(viewerActor, project.id, "fr"),
		).resolves.toHaveLength(1);
		// writes are refused across every mutating surface
		await expect(
			svc.translations.set(viewerActor, project.id, "fr", {
				name: "greeting",
				value: "x",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			svc.members.add(
				viewerActor,
				project.id,
				{ email: "x@acme.com" },
				"VIEWER",
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			svc.glossary.add(viewerActor, project.id, { term: "x" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			svc.webhooks.list(viewerActor, project.id),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("imports keys, prunes absent ones, and paginates by cursor", async () => {
		const project = await newProject(owner, "Import", []);
		const imported = await svc.keys.import(owner, project.id, [
			{ name: "keep.me", baseValue: "Keep" },
			{ name: "drop.me", baseValue: "Drop" },
		]);
		expect(imported.created).toBe(2);
		expect(imported.baseValuesSet).toBe(2);

		// --prune removes keys absent from the source set (same no-namespace keyspace)
		const pruned = await svc.keys.import(
			owner,
			project.id,
			[{ name: "keep.me", baseValue: "Keep" }],
			undefined,
			{ prune: true },
		);
		expect(pruned.deleted).toBe(1);
		expect(
			(await repo.listKeyDefs(project.id, MAIN_BRANCH_ID)).map((k) => k.name),
		).toEqual(["keep.me"]);

		// pagination walks the whole partition via the cursor, no dupes, no gaps
		for (let i = 0; i < 5; i++) {
			await svc.keys.create(owner, project.id, { name: `page.k${i}` });
		}
		const seen = new Set<string>();
		let cursor: string | undefined;
		let pages = 0;
		do {
			const page = await svc.keys.listPage(owner, project.id, {
				limit: 2,
				cursor,
			});
			page.keys.forEach((k) => seen.add(k.name));
			cursor = page.nextCursor;
			pages++;
		} while (cursor && pages < 20);
		expect(seen.size).toBe(6); // keep.me + 5 page.k*
	});

	it("manages glossary, webhooks, members, and api-key revocation", async () => {
		const project = await newProject(owner, "Admin", ["fr"]);

		// glossary CRUD
		const term = await svc.glossary.add(owner, project.id, {
			term: "Turjuman",
			doNotTranslate: true,
			notes: "Brand name",
		});
		expect(
			(await svc.glossary.list(owner, project.id)).map((t) => t.term),
		).toEqual(["Turjuman"]);
		const renamed = await svc.glossary.update(owner, project.id, term.id, {
			translations: { fr: "Turjuman" },
		});
		expect(renamed.translations).toEqual({ fr: "Turjuman" });
		await svc.glossary.remove(owner, project.id, term.id);
		expect(await svc.glossary.list(owner, project.id)).toHaveLength(0);

		// webhooks CRUD
		const webhook = await svc.webhooks.add(owner, project.id, {
			url: "https://example.com/hook",
			events: ["translation.updated"],
		});
		expect(webhook.secret).toMatch(/^whsec_/);
		expect(await svc.webhooks.list(owner, project.id)).toHaveLength(1);
		await svc.webhooks.remove(owner, project.id, webhook.id);
		expect(await svc.webhooks.list(owner, project.id)).toHaveLength(0);

		// add_member auto-provisions an unknown email for an admin
		const provisioned = await svc.members.add(
			owner,
			project.id,
			{ email: "newbie@acme.com", name: "Newbie" },
			"EDITOR",
		);
		expect(provisioned.role).toBe("EDITOR");
		expect((await svc.users.list(owner)).map((u) => u.email)).toContain(
			"newbie@acme.com",
		);

		// a revoked api key no longer authenticates
		const throwaway = await svc.apiKeys.create(owner, {
			name: "throwaway",
			userId: provisioned.userId,
		});
		expect(await authenticate(repo, throwaway.secret)).toBeTruthy();
		await svc.apiKeys.revoke(owner, throwaway.apiKey.id, provisioned.userId);
		expect(await authenticate(repo, throwaway.secret)).toBeUndefined();
	});

	it("cascades a project delete across every partition", async () => {
		const doomed = await newProject(owner, "Doomed", ["fr"]);
		const key = await svc.keys.create(owner, doomed.id, {
			name: "temp.key",
			baseValue: "x",
		});
		await svc.translations.set(owner, doomed.id, "fr", {
			name: "temp.key",
			value: "y",
		});
		await svc.translations.accept(owner, doomed.id, "fr", "temp.key");
		await svc.glossary.add(owner, doomed.id, { term: "X" });
		await svc.releases.create(owner, doomed.id, {
			label: "v1",
			locales: ["fr"],
		});
		void key;

		// deleting a populated project requires explicit confirmation
		await expect(
			svc.projects.delete(owner, doomed.id, false),
		).rejects.toMatchObject({ code: "VALIDATION" });
		await svc.projects.delete(owner, doomed.id, true);

		expect(await repo.getProject(doomed.id)).toBeUndefined();
		expect(await repo.listKeyDefs(doomed.id, MAIN_BRANCH_ID)).toHaveLength(0);
		expect(await repo.listLocales(doomed.id)).toHaveLength(0);
		expect(await repo.listGlossary(doomed.id)).toHaveLength(0);
		expect(
			await repo.listCellsByLocale(doomed.id, MAIN_BRANCH_ID, "en"),
		).toHaveLength(0);
		expect(await repo.listReleases(doomed.id)).toHaveLength(0);
	});

	it("refuses a second owner and isolates tenants", async () => {
		const mine = await newProject(owner, "Mine", []);

		// the bootstrap guard refuses a second owner in a populated org…
		await expect(
			bootstrapOwner(repo, { email: "second@acme.com", name: "Second" }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		// …unless forced
		const forced = await bootstrapOwner(repo, {
			email: "second@acme.com",
			name: "Second",
			force: true,
		});
		expect(forced.user.globalRole).toBe("OWNER");

		// a different org sees none of this org's projects
		const other = await bootstrapOwner(repo, {
			email: "owner@other.com",
			name: "Other",
			orgId: "other",
		});
		const otherActor = (await authenticate(repo, other.secret))!.actor;
		expect(await svc.projects.list(otherActor)).toHaveLength(0);
		await expect(svc.projects.get(otherActor, mine.id)).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
	});
});

/**
 * The low-level single-table invariants — the ones the in-memory fake can only
 * mimic: transacted uniqueness, GSI partitioning, the `head` compare-and-swap,
 * and a release's split-partition storage. Each test builds its own project, so
 * they stay independent. Skipped with the same env guard.
 */
describe.skipIf(!endpoint)("single-table invariants (DynamoDB)", () => {
	let owner: Actor;
	beforeAll(async () => {
		await createTable();
		const boot = await bootstrapOwner(repo, {
			email: "inv-owner@acme.com",
			name: "Inv Owner",
		});
		owner = (await authenticate(repo, boot.secret))!.actor;
	}, 60_000);
	afterAll(dropTable);

	it("enforces email uniqueness atomically via the transacted companion item", async () => {
		const a = await svc.users.create(owner, {
			email: "dup@acme.com",
			name: "A",
		});
		// The second create fails the companion item's attribute_not_exists condition,
		// so the whole TransactWrite rolls back — no orphan user, no second email item.
		await expect(
			svc.users.create(owner, { email: "dup@acme.com", name: "B" }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		// A case variant collides too: the email index key is lower-cased.
		await expect(
			svc.users.create(owner, { email: "DUP@acme.com", name: "C" }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		// Exactly one user holds the email, and it is the first one (no partial write).
		expect((await repo.getUserByEmail("dup@acme.com"))?.id).toBe(a.id);
		expect(
			(await repo.listUsersByOrg(owner.orgId)).filter(
				(u) => u.email === "dup@acme.com",
			),
		).toHaveLength(1);
	});

	it("partitions GSI1 by org and fans out GSI3 by (branch, key)", async () => {
		// GSI1 ("by org"): a project created in another org never appears in this org's
		// query, and vice-versa — the GSI1PK is the org, so the partitions are disjoint.
		const mine = await svc.projects.create(owner, {
			name: "Mine",
			baseLocale: "en",
		});
		const otherBoot = await bootstrapOwner(repo, {
			email: "gsi-other@acme.com",
			name: "Other",
			orgId: "gsi-other-org",
		});
		const otherActor = (await authenticate(repo, otherBoot.secret))!.actor;
		const theirs = await svc.projects.create(otherActor, {
			name: "Theirs",
			baseLocale: "en",
		});

		const myProjectIds = (await repo.listProjectsByOrg(owner.orgId)).map(
			(p) => p.id,
		);
		expect(myProjectIds).toContain(mine.id);
		expect(myProjectIds).not.toContain(theirs.id);
		expect(
			(await repo.listProjectsByOrg("gsi-other-org")).map((p) => p.id),
		).toEqual([theirs.id]);

		// GSI3 ("by branch+key"): one key's cells across every locale come back from a
		// single PK-only query on the key's branch-scoped GSI3PK.
		await svc.locales.add(owner, mine.id, "fr");
		await svc.locales.add(owner, mine.id, "es");
		const key = await svc.keys.create(owner, mine.id, {
			name: "greeting",
			baseValue: "Hello",
		});
		await svc.translations.set(owner, mine.id, "fr", {
			name: "greeting",
			value: "Bonjour",
		});
		await svc.translations.set(owner, mine.id, "es", {
			name: "greeting",
			value: "Hola",
		});
		const byKey = await repo.listCellsByKey(mine.id, MAIN_BRANCH_ID, key.id);
		expect(byKey.map((c) => c.locale).sort()).toEqual(["en", "es", "fr"]);
	});

	it("guards head with a real conditional accept (compare-and-swap)", async () => {
		const project = await svc.projects.create(owner, {
			name: "Cas",
			baseLocale: "en",
		});
		await svc.locales.add(owner, project.id, "fr");
		const key = await svc.keys.create(owner, project.id, {
			name: "greeting",
			baseValue: "Hello",
		});
		await svc.translations.set(owner, project.id, "fr", {
			name: "greeting",
			value: "Bonjour",
		});
		const coords = {
			projectId: project.id,
			branchId: MAIN_BRANCH_ID,
			keyId: key.id,
			locale: "fr",
			updatedBy: owner.userId,
		};
		// Two accepts racing off the same (empty) head: the DynamoDB conditional
		// write lets the first win; the second — still believing head is unset —
		// fails its ConditionExpression and surfaces as CONFLICT.
		await repo.acceptCell({
			...coords,
			value: "Bonjour",
			acceptedBy: owner.userId,
		});
		await expect(
			repo.acceptCell({ ...coords, value: "Salut", acceptedBy: owner.userId }),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("reassembles a release from its split META + entry partitions", async () => {
		const project = await svc.projects.create(owner, {
			name: "RelStore",
			baseLocale: "en",
		});
		await svc.locales.add(owner, project.id, "fr");
		await svc.keys.create(owner, project.id, {
			name: "greeting",
			baseValue: "Hello",
		});
		await svc.translations.set(owner, project.id, "fr", {
			name: "greeting",
			value: "Bonjour",
		});
		await svc.translations.accept(owner, project.id, "fr", "greeting");
		const release = await svc.releases.create(owner, project.id, {
			label: "v1",
			locales: ["fr"],
		});

		// listReleases returns META rows only (entries live in a separate partition)…
		const meta = (await repo.listReleases(project.id)).find(
			(r) => r.id === release.id,
		);
		expect(meta?.entries).toEqual([]);
		// …and getRelease reassembles the pinned entries from the per-release partition.
		const full = await repo.getRelease(project.id, release.id);
		expect(full?.entries).toHaveLength(1);
	});

	it("walks the key partition by cursor with no duplicates and no gaps", async () => {
		const project = await svc.projects.create(owner, {
			name: "Paged",
			baseLocale: "en",
		});
		const total = 7;
		for (let i = 0; i < total; i++) {
			// Zero-padded so the lexical SK order is the obvious numeric order.
			await svc.keys.create(owner, project.id, {
				name: `k${String(i).padStart(2, "0")}`,
			});
		}
		const whole = (await repo.listKeyDefs(project.id, MAIN_BRANCH_ID)).map(
			(k) => k.name,
		);
		expect(whole).toHaveLength(total);

		// Page at a limit that doesn't divide the total, so the last page is partial.
		const limit = 3;
		const seen: string[] = [];
		let cursor: string | undefined;
		let pages = 0;
		do {
			const page = await repo.listKeyDefsPage(project.id, MAIN_BRANCH_ID, {
				limit,
				cursor,
			});
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
