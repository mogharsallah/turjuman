import type { Branch, Translation, TranslationKey } from "@turjuman/schema";
import { MAIN_BRANCH_ID } from "@turjuman/schema";
import { describe, expect, it } from "vitest";
import { makeFakeRepo } from "./testing/fake-repo.js";

/**
 * Hermetic coverage of the copy-on-write repository primitives — materialize,
 * provenance/version fall-through, per-branch tombstones, the resolved overlays,
 * and the namespace-uniqueness transaction — driven straight against the
 * {@link FakeRepo}. These are exercised below the service layer (the services
 * route through them in Batch 2), so this pins the overlay/tombstone algorithm
 * the fake shares with the real single-table repository; `integration.test.ts`
 * proves the same behaviour against real DynamoDB.
 */

const PID = "proj_cow";
const now = () => new Date().toISOString();

const branch = (id: string, parentBranchId: string | null): Branch => ({
	id,
	projectId: PID,
	name: id,
	parentBranchId,
	status: "open",
	createdBy: "u1",
	createdAt: now(),
});

const key = (id: string, name: string): TranslationKey => ({
	id,
	projectId: PID,
	name,
	plural: false,
	tags: [],
	state: "active",
	sourceRevision: "r1",
	createdAt: now(),
	updatedAt: now(),
});

const cell = (
	branchId: string,
	keyId: string,
	locale: string,
	value: string,
	head?: number,
): Translation => ({
	projectId: PID,
	branchId,
	keyId,
	locale,
	value,
	head,
	lifecycle: head ? "accepted" : "proposed",
	stale: false,
	updatedBy: "u1",
	updatedAt: now(),
});

/** A fake repo with a `main` branch and one child forked off it. */
async function forked() {
	const repo = makeFakeRepo();
	await repo.putBranch(branch(MAIN_BRANCH_ID, null));
	await repo.putBranch(branch("br_child", MAIN_BRANCH_ID));
	return repo;
}

describe("materializeCell", () => {
	it("copies an inherited cell so an accept on the child can land", async () => {
		const repo = await forked();
		await repo.createKeyDef(MAIN_BRANCH_ID, key("k1", "greeting"));
		await repo.putCell(cell(MAIN_BRANCH_ID, "k1", "fr", "Bonjour", 1));

		const accept = {
			projectId: PID,
			branchId: "br_child",
			keyId: "k1",
			locale: "fr",
			value: "Salut",
			expectedHead: 1,
			updatedBy: "u1",
		};
		// The child owns no cell row, so the CAS has nothing to update → CONFLICT.
		await expect(repo.acceptCell(accept)).rejects.toMatchObject({
			code: "CONFLICT",
		});

		const copied = await repo.materializeCell(PID, "br_child", "k1", "fr");
		expect(copied?.branchId).toBe("br_child");
		expect(copied?.head).toBe(1);
		// Idempotent: a second materialize returns the same child row, no advance.
		expect(
			(await repo.materializeCell(PID, "br_child", "k1", "fr"))?.head,
		).toBe(1);

		const accepted = await repo.acceptCell(accept);
		expect(accepted.head).toBe(2);
		expect((await repo.getCell(PID, "br_child", "k1", "fr"))?.value).toBe(
			"Salut",
		);
		// main is isolated from the child's accept.
		expect((await repo.getCell(PID, MAIN_BRANCH_ID, "k1", "fr"))?.head).toBe(1);
		expect((await repo.getCell(PID, MAIN_BRANCH_ID, "k1", "fr"))?.value).toBe(
			"Bonjour",
		);
	});

	it("is a no-op read when the branch already owns the cell", async () => {
		const repo = await forked();
		await repo.createKeyDef(MAIN_BRANCH_ID, key("k1", "greeting"));
		await repo.putCell(cell("br_child", "k1", "fr", "Salut", 3));
		const got = await repo.materializeCell(PID, "br_child", "k1", "fr");
		expect(got?.value).toBe("Salut");
		expect(got?.head).toBe(3);
	});
});

describe("version fall-through", () => {
	it("resolves an inherited version but not via the plain getter", async () => {
		const repo = await forked();
		await repo.createKeyDef(MAIN_BRANCH_ID, key("k1", "greeting"));
		await repo.putCell(cell(MAIN_BRANCH_ID, "k1", "fr", "start"));
		await repo.acceptCell({
			projectId: PID,
			branchId: MAIN_BRANCH_ID,
			keyId: "k1",
			locale: "fr",
			value: "Bonjour",
			updatedBy: "u1",
		}); // main seq 1

		expect(
			await repo.getVersion(PID, "br_child", "k1", "fr", 1),
		).toBeUndefined();
		expect(
			(await repo.getVersionResolved(PID, "br_child", "k1", "fr", 1))?.value,
		).toBe("Bonjour");
	});
});

describe("per-branch tombstones", () => {
	it("delete on a child hides an inherited key; main is untouched", async () => {
		const repo = await forked();
		await repo.createKeyDef(MAIN_BRANCH_ID, key("k1", "greeting"));
		await repo.deleteKeyDefsCascade(PID, "br_child", [
			{ id: "k1", namespaceId: undefined, name: "greeting" },
		]);

		expect(await repo.getKeyDef(PID, "br_child", "k1")).toBeUndefined();
		expect(
			await repo.resolveKeyIdByName(PID, "br_child", undefined, "greeting"),
		).toBeUndefined();
		expect(
			(await repo.listKeyDefsResolved(PID, "br_child")).map((k) => k.id),
		).not.toContain("k1");

		expect((await repo.getKeyDef(PID, MAIN_BRANCH_ID, "k1"))?.id).toBe("k1");
		expect(
			await repo.resolveKeyIdByName(PID, MAIN_BRANCH_ID, undefined, "greeting"),
		).toBe("k1");
		expect(
			(await repo.listKeyDefsResolved(PID, MAIN_BRANCH_ID)).map((k) => k.id),
		).toContain("k1");
	});

	it("rename on a child frees the old name there and reuses it, ancestor intact", async () => {
		const repo = await forked();
		await repo.createKeyDef(MAIN_BRANCH_ID, key("k1", "greeting"));
		await repo.renameKeyDef(
			"br_child",
			{ ...key("k1", "hello"), updatedAt: now() },
			{ namespaceId: undefined, name: "greeting" },
		);

		expect(
			await repo.resolveKeyIdByName(PID, "br_child", undefined, "hello"),
		).toBe("k1");
		expect(
			await repo.resolveKeyIdByName(PID, "br_child", undefined, "greeting"),
		).toBeUndefined();
		expect((await repo.getKeyDef(PID, "br_child", "k1"))?.name).toBe("hello");
		// main still knows only the original name.
		expect(
			await repo.resolveKeyIdByName(PID, MAIN_BRANCH_ID, undefined, "greeting"),
		).toBe("k1");
		// the freed old name is reclaimable on the child (uniqueness ignores a tombstone).
		await repo.createKeyDef("br_child", key("k2", "greeting"));
		expect(
			await repo.resolveKeyIdByName(PID, "br_child", undefined, "greeting"),
		).toBe("k2");
	});
});

describe("resolved cell overlay", () => {
	it("overlays child cells on inherited ones and drops tombstoned keys", async () => {
		const repo = await forked();
		await repo.createKeyDef(MAIN_BRANCH_ID, key("k1", "a"));
		await repo.createKeyDef(MAIN_BRANCH_ID, key("k2", "b"));
		await repo.putCell(cell(MAIN_BRANCH_ID, "k1", "fr", "A-main", 1));
		await repo.putCell(cell(MAIN_BRANCH_ID, "k2", "fr", "B-main", 1));
		// the child overrides k1 and deletes k2
		await repo.putCell(cell("br_child", "k1", "fr", "A-child", 1));
		await repo.deleteKeyDefsCascade(PID, "br_child", [
			{ id: "k2", namespaceId: undefined, name: "b" },
		]);

		const resolved = await repo.listCellsByLocaleResolved(
			PID,
			"br_child",
			"fr",
		);
		const byId = new Map(resolved.map((c) => [c.keyId, c.value]));
		expect(byId.get("k1")).toBe("A-child"); // nearest branch wins
		expect(byId.has("k2")).toBe(false); // its key was tombstoned → dropped
	});
});

describe("namespace uniqueness", () => {
	it("rejects a duplicate name and moves the guard on rename", async () => {
		const repo = makeFakeRepo();
		const ns = (id: string, name: string) => ({
			id,
			projectId: PID,
			name,
			lifecycle: "active" as const,
			createdAt: now(),
			updatedAt: now(),
		});
		await repo.createNamespace(ns("ns_a", "web"));
		await expect(repo.createNamespace(ns("ns_b", "web"))).rejects.toMatchObject(
			{
				code: "CONFLICT",
			},
		);

		await repo.createNamespace(ns("ns_c", "mobile"));
		// renaming onto a taken name conflicts…
		await expect(
			repo.renameNamespace(ns("ns_c", "web"), "mobile"),
		).rejects.toMatchObject({ code: "CONFLICT" });
		// …and once the old name is freed it is reusable.
		await repo.renameNamespace(ns("ns_a", "web2"), "web");
		await repo.createNamespace(ns("ns_d", "web"));
	});
});
