import { MAIN_BRANCH_ID } from "@turjuman/schema";
import { describe, expect, it } from "vitest";
import { project } from "./testing/fake-repo.js";

/**
 * L4 service coverage of the copy-on-write cluster and the standalone correctness
 * fixes (batch 2): every resolve-then-mutate / enumeration behaves on a child
 * branch, base-locale writes carry a version chain, and the namespace guard, run
 * idempotency, QA accepted slot, and resolve staleness-boomerang fixes hold.
 * Driven through the {@link TurjumanService} facade against the {@link FakeRepo} —
 * an independent oracle from the single-table repository the same invariants are
 * pinned against in `repository-cow.test.ts` / `integration.test.ts`.
 */

describe("copy-on-write cluster (child branches)", () => {
	it("accepts a child-branch draft without touching main's cell", async () => {
		const { svc, actor, projectId } = await project();
		await svc.keys.create(actor, projectId, {
			name: "greeting",
			baseValue: "Hello",
		});
		await svc.translations.set(actor, projectId, "fr", {
			name: "greeting",
			value: "Bonjour",
		});
		await svc.translations.accept(actor, projectId, "fr", "greeting");
		const branch = (
			await svc.branches.create(actor, projectId, { name: "feature" })
		).id;

		await svc.translations.set(actor, projectId, "fr", {
			name: "greeting",
			value: "Salut",
			branch,
		});
		const accepted = await svc.translations.accept(
			actor,
			projectId,
			"fr",
			"greeting",
			{ branch },
		);
		expect(accepted.lifecycle).toBe("accepted");
		expect(accepted.value).toBe("Salut");
		// main is isolated from the child's accept.
		const onMain = await svc.translations.listForKey(
			actor,
			projectId,
			"greeting",
		);
		expect(onMain.find((t) => t.locale === "fr")?.value).toBe("Bonjour");
	});

	it("escalates only the child's cell, not the shared parent (no contamination)", async () => {
		const { svc, actor, projectId } = await project();
		await svc.keys.create(actor, projectId, {
			name: "greeting",
			baseValue: "Hello",
		});
		await svc.translations.set(actor, projectId, "fr", {
			name: "greeting",
			value: "Bonjour",
		});
		await svc.translations.accept(actor, projectId, "fr", "greeting");
		const branch = (
			await svc.branches.create(actor, projectId, { name: "feature" })
		).id;

		await svc.escalations.open(actor, projectId, "fr", "greeting", {
			branch,
			reason: "please review",
		});
		const onChild = await svc.translations.listForKey(
			actor,
			projectId,
			"greeting",
			undefined,
			branch,
		);
		expect(onChild.find((t) => t.locale === "fr")?.lifecycle).toBe("escalated");
		// main's cell is untouched.
		const onMain = await svc.translations.listForKey(
			actor,
			projectId,
			"greeting",
		);
		expect(onMain.find((t) => t.locale === "fr")?.lifecycle).toBe("accepted");
	});

	it("lists a child branch's keys and cells including inherited ones", async () => {
		const { svc, actor, projectId } = await project();
		await svc.keys.create(actor, projectId, { name: "a", baseValue: "A" });
		await svc.keys.create(actor, projectId, { name: "b", baseValue: "B" });
		const branch = (
			await svc.branches.create(actor, projectId, { name: "feature" })
		).id;
		await svc.keys.create(actor, projectId, {
			name: "c",
			baseValue: "C",
			branch,
		});

		expect(
			(await svc.keys.list(actor, projectId, { branch }))
				.map((k) => k.name)
				.sort(),
		).toEqual(["a", "b", "c"]);
		const bundle = await svc.translations.exportBundle(actor, projectId, "en", {
			branch,
		});
		const byKey = new Map(bundle.map((e) => [e.key, e.value]));
		expect(byKey.get("a")).toBe("A"); // inherited base value
		expect(byKey.get("c")).toBe("C"); // branch-introduced
	});

	it("deletes an inherited key on a child (hidden there, intact on main)", async () => {
		const { svc, actor, projectId } = await project();
		await svc.keys.create(actor, projectId, {
			name: "greeting",
			baseValue: "Hello",
		});
		const branch = (
			await svc.branches.create(actor, projectId, { name: "feature" })
		).id;
		await svc.keys.delete(
			actor,
			projectId,
			"greeting",
			true,
			undefined,
			branch,
		);

		await expect(
			svc.keys.get(actor, projectId, "greeting", undefined, branch),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(
			(await svc.keys.list(actor, projectId, { branch })).map((k) => k.name),
		).not.toContain("greeting");
		expect((await svc.keys.get(actor, projectId, "greeting")).key.name).toBe(
			"greeting",
		);
	});

	it("short-circuits a rename to the same coordinate (no self-collision)", async () => {
		const { svc, actor, projectId } = await project();
		const key = await svc.keys.create(actor, projectId, {
			name: "greeting",
			baseValue: "Hello",
		});
		const same = await svc.keys.rename(actor, projectId, "greeting", {
			name: "greeting",
		});
		expect(same.id).toBe(key.id);
		expect(same.name).toBe("greeting");
	});
});

describe("standalone service correctness", () => {
	it("versions the base locale so a release can pin it", async () => {
		const { repo, svc, actor, projectId } = await project();
		const key = await svc.keys.create(actor, projectId, {
			name: "greeting",
			baseValue: "Hello",
		});
		await svc.translations.set(actor, projectId, "en", {
			name: "greeting",
			value: "Hi",
		});
		// re-writing the same source value appends no redundant version.
		await svc.translations.set(actor, projectId, "en", {
			name: "greeting",
			value: "Hi",
		});
		const history = await repo.getCellHistory(
			projectId,
			MAIN_BRANCH_ID,
			key.id,
			"en",
		);
		expect(history.map((v) => v.value)).toEqual(["Hello", "Hi"]);

		const release = await svc.releases.create(actor, projectId, {
			label: "v1",
		});
		const enEntry = release.entries.find(
			(e) => e.keyId === key.id && e.locale === "en",
		);
		expect(enEntry?.versionRef).toBe(2);
	});

	it("skips a bulkSet entry whose namespace does not exist", async () => {
		const { svc, actor, projectId } = await project();
		// a namespace-less key that a mis-bucketed entry could wrongly match.
		await svc.keys.create(actor, projectId, {
			name: "submit",
			baseValue: "OK",
		});
		const res = await svc.translations.bulkSet(actor, projectId, "fr", [
			{ name: "submit", namespace: "ghost", value: "Envoyer" },
		]);
		expect(res.written).toBe(0);
		expect(res.skipped).toEqual(["ghost/submit"]);
		const cells = await svc.translations.listForKey(actor, projectId, "submit");
		expect(cells.find((t) => t.locale === "fr")).toBeUndefined();
	});

	it("registers a changed base locale as a usable locale", async () => {
		const { svc, actor, projectId } = await project();
		await svc.projects.update(actor, projectId, { baseLocale: "es" });
		await svc.keys.create(actor, projectId, {
			name: "greeting",
			baseValue: "Hola",
		});
		// writing the new base locale passes the locale-exists guard.
		const set = await svc.translations.set(actor, projectId, "es", {
			name: "greeting",
			value: "Hola!",
		});
		expect(set.value).toBe("Hola!");
	});

	it("returns the original run for a repeated idempotency key", async () => {
		const { svc, actor, projectId } = await project();
		const first = await svc.runs.start(actor, projectId, {
			idempotencyKey: "k1",
		});
		const again = await svc.runs.start(actor, projectId, {
			idempotencyKey: "k1",
		});
		expect(again.id).toBe(first.id);
		const other = await svc.runs.start(actor, projectId, {
			idempotencyKey: "k2",
		});
		expect(other.id).not.toBe(first.id);
	});

	it("reads the accepted head in QA's accepted slot, not a newer draft", async () => {
		const { svc, actor, projectId } = await project();
		await svc.keys.create(actor, projectId, {
			name: "greeting",
			baseValue: "Hi",
		});
		await svc.translations.set(actor, projectId, "fr", {
			name: "greeting",
			value: "Bonjour {name}",
		});
		await svc.translations.accept(actor, projectId, "fr", "greeting");
		// Re-draft over the accepted head, dropping the placeholder.
		await svc.translations.set(actor, projectId, "fr", {
			name: "greeting",
			value: "Bonjour",
		});

		const accepted = await svc.qa.run(actor, projectId, {
			locale: "fr",
			checkIds: ["placeholders"],
			slot: "accepted",
		});
		// The accepted head ("Bonjour {name}") carries the placeholder the base lacks.
		expect(
			accepted.findings.filter((f) => f.checkId === "placeholders"),
		).toHaveLength(1);
		const working = await svc.qa.run(actor, projectId, {
			locale: "fr",
			checkIds: ["placeholders"],
			slot: "working",
		});
		// The working draft ("Bonjour") matches the base — nothing to flag.
		expect(
			working.findings.filter((f) => f.checkId === "placeholders"),
		).toHaveLength(0);
	});

	it("does not re-stale the cell a resolution just accepted", async () => {
		const { repo, svc, actor, projectId } = await project();
		const key = await svc.keys.create(actor, projectId, {
			name: "greeting",
			baseValue: "Hello",
		});
		await svc.translations.set(actor, projectId, "fr", {
			name: "greeting",
			value: "Bonjour",
		});
		const esc = await svc.escalations.open(actor, projectId, "fr", "greeting", {
			reason: "review",
		});
		// Resolving spawns an Example → a context change that fans out staleness.
		await svc.escalations.resolve(actor, projectId, esc.id, {
			spawnExample: true,
		});
		const fr = await repo.getCell(projectId, MAIN_BRANCH_ID, key.id, "fr");
		expect(fr?.lifecycle).toBe("accepted");
		expect(fr?.stale).toBe(false); // excluded from its own resolution's fan-out
	});
});
