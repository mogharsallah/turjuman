import { MAIN_BRANCH_ID } from "@turjuman/schema";
import { describe, expect, it } from "vitest";
import { ownerActor, setup } from "./testing/fake-repo.js";

/**
 * Hermetic coverage of the rebuilt data model's hard parts — the invariants the
 * cell/branch/version design turns on, proven against the in-memory
 * {@link FakeRepo} (which mirrors the real repository's CAS and copy-on-write).
 * Independent of the legacy service tests: this asserts the new behaviour
 * directly (accept compare-and-swap, the human-accept gate, source-revision
 * staleness, rename-by-id, namespace identity, accepted-vs-working export).
 */

async function project(email = "owner@acme.com") {
	const { repo, svc } = setup();
	const { actor } = await ownerActor(repo, { email });
	const p = await svc.projects.create(actor, {
		name: "App",
		baseLocale: "en",
	});
	await svc.locales.add(actor, p.id, "fr");
	return { repo, svc, actor, projectId: p.id };
}

describe("project bootstrap", () => {
	it("creates the root main branch and seeds the base locale", async () => {
		const { svc, actor, projectId } = await project();
		const branches = await svc.branches.list(actor, projectId);
		expect(branches.map((b) => b.id)).toEqual([MAIN_BRANCH_ID]);
		expect(branches[0]?.parentBranchId).toBeNull();
		const proj = await svc.projects.get(actor, projectId);
		expect(proj.contextRevision).toBe(0);
		expect(proj.requireHumanAccept).toBe(false);
	});
});

describe("keys carry opaque identity + a source revision", () => {
	it("creates a key with a base value and stamps its revision", async () => {
		const { svc, actor, projectId } = await project();
		const key = await svc.keys.create(actor, projectId, {
			name: "greeting",
			baseValue: "Hello",
		});
		expect(key.id).toMatch(/^key_/);
		expect(key.sourceRevision).not.toBe("");
		const { translations } = await svc.keys.get(actor, projectId, "greeting");
		const base = translations.find((t) => t.locale === "en");
		expect(base?.value).toBe("Hello");
		expect(base?.lifecycle).toBe("accepted");
	});
});

describe("the accept transition", () => {
	it("proposes a draft, then accepts it into the version chain", async () => {
		const { repo, svc, actor, projectId } = await project();
		const key = await svc.keys.create(actor, projectId, {
			name: "greeting",
			baseValue: "Hello",
		});
		const draft = await svc.translations.set(actor, projectId, "fr", {
			name: "greeting",
			value: "Bonjour",
		});
		expect(draft.lifecycle).toBe("proposed");
		expect(draft.head).toBeUndefined();
		expect(draft.sourceRef).toBe(key.sourceRevision);

		const accepted = await svc.translations.accept(
			actor,
			projectId,
			"fr",
			"greeting",
		);
		expect(accepted.lifecycle).toBe("accepted");
		expect(accepted.head).toBe(1);
		const history = await repo.getCellHistory(
			projectId,
			MAIN_BRANCH_ID,
			key.id,
			"fr",
		);
		expect(history).toHaveLength(1);
		expect(history[0]?.value).toBe("Bonjour");
		expect(history[0]?.acceptedBy).toBe(actor.userId);
	});

	it("guards head with compare-and-swap (a stale accept loses)", async () => {
		const { repo, svc, actor, projectId } = await project();
		const key = await svc.keys.create(actor, projectId, {
			name: "greeting",
			baseValue: "Hello",
		});
		await svc.translations.set(actor, projectId, "fr", {
			name: "greeting",
			value: "Bonjour",
		});
		const coords = {
			projectId,
			branchId: MAIN_BRANCH_ID,
			keyId: key.id,
			locale: "fr",
			updatedBy: actor.userId,
		};
		// Two accepts racing off the same (empty) head: the first wins, the second
		// — still believing head is unset — is rejected.
		await repo.acceptCell({
			...coords,
			value: "Bonjour",
			acceptedBy: actor.userId,
		});
		await expect(
			repo.acceptCell({ ...coords, value: "Salut", acceptedBy: actor.userId }),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});
});

describe("requireHumanAccept gate", () => {
	it("rejects a run-attributed accept but allows a human one", async () => {
		const { svc, actor, projectId } = await project();
		await svc.projects.update(actor, projectId, { requireHumanAccept: true });
		await svc.keys.create(actor, projectId, {
			name: "greeting",
			baseValue: "Hello",
		});
		await svc.translations.set(actor, projectId, "fr", {
			name: "greeting",
			value: "Bonjour",
		});
		await expect(
			svc.translations.accept(actor, projectId, "fr", "greeting", {
				runRef: "run_123",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		const human = await svc.translations.accept(
			actor,
			projectId,
			"fr",
			"greeting",
		);
		expect(human.lifecycle).toBe("accepted");
	});
});

describe("source-revision staleness", () => {
	it("flags a target stale once the base value moves on", async () => {
		const { svc, actor, projectId } = await project();
		await svc.keys.create(actor, projectId, {
			name: "greeting",
			baseValue: "Hello",
		});
		await svc.translations.set(actor, projectId, "fr", {
			name: "greeting",
			value: "Bonjour",
		});
		expect(
			await svc.translations.listStale(actor, projectId, "fr"),
		).toHaveLength(0);
		// Move the source on (a base-locale write bumps the key's sourceRevision).
		await svc.translations.set(actor, projectId, "en", {
			name: "greeting",
			value: "Hi",
		});
		const stale = await svc.translations.listStale(actor, projectId, "fr");
		expect(stale.map((k) => k.name)).toEqual(["greeting"]);
	});
});

describe("rename by id preserves translations", () => {
	it("moves the labels but keeps the cell under the same key id", async () => {
		const { svc, actor, projectId } = await project();
		const key = await svc.keys.create(actor, projectId, {
			name: "old_name",
			baseValue: "Hello",
		});
		await svc.translations.set(actor, projectId, "fr", {
			name: "old_name",
			value: "Bonjour",
		});
		const renamed = await svc.keys.rename(actor, projectId, "old_name", {
			name: "new_name",
		});
		expect(renamed.id).toBe(key.id);
		await expect(
			svc.keys.get(actor, projectId, "old_name"),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		const moved = await svc.keys.get(actor, projectId, "new_name");
		expect(moved.translations.find((t) => t.locale === "fr")?.value).toBe(
			"Bonjour",
		);
	});
});

describe("namespaces are first-class identities", () => {
	it("auto-creates a namespace on first use and scopes the key to it", async () => {
		const { svc, actor, projectId } = await project();
		await svc.keys.create(actor, projectId, {
			name: "submit",
			namespace: "common",
			baseValue: "OK",
		});
		const namespaces = await svc.namespaces.list(actor, projectId);
		expect(namespaces.map((n) => n.name)).toContain("common");
		const scoped = await svc.keys.get(actor, projectId, "submit", "common");
		expect(scoped.key.namespaceId).toBe(namespaces[0]?.id);
		// The same name with no namespace is a different (absent) key.
		await expect(
			svc.keys.get(actor, projectId, "submit"),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

describe("export ships accepted values, falling back to source", () => {
	it("ships the accepted value and falls back for un-accepted cells", async () => {
		const { svc, actor, projectId } = await project();
		await svc.keys.create(actor, projectId, { name: "a", baseValue: "Hello" });
		await svc.keys.create(actor, projectId, { name: "b", baseValue: "World" });
		// a: proposed then accepted; b: proposed only.
		await svc.translations.set(actor, projectId, "fr", {
			name: "a",
			value: "Bonjour",
		});
		await svc.translations.accept(actor, projectId, "fr", "a");
		await svc.translations.set(actor, projectId, "fr", {
			name: "b",
			value: "Monde",
		});
		const accepted = await svc.translations.exportBundle(
			actor,
			projectId,
			"fr",
		);
		const byKey = new Map(accepted.map((e) => [e.key, e.value]));
		expect(byKey.get("a")).toBe("Bonjour"); // accepted
		expect(byKey.get("b")).toBe("World"); // fell back to source (not accepted)
		const working = await svc.translations.exportBundle(
			actor,
			projectId,
			"fr",
			{
				slot: "working",
			},
		);
		expect(new Map(working.map((e) => [e.key, e.value])).get("b")).toBe(
			"Monde",
		);
	});
});
