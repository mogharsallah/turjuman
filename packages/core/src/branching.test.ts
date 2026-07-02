import { MAIN_BRANCH_ID } from "@turjuman/schema";
import { describe, expect, it, vi } from "vitest";
import { ownerActor, setup } from "./testing/fake-repo.js";

/**
 * Hermetic coverage of the Batch 3 spine — branching, releases, and field
 * reports — proven against the in-memory {@link FakeRepo}. Branches exercise the
 * copy-on-write fall-through built in Batch 1 with real non-`main` parent chains;
 * merge is a `TranslationRun` that transports accepted values (conflict →
 * escalation, no budget); a release pins a branch immutably; a field report
 * reopens a cell and compounds the fix into reusable context.
 */

async function project(email = "owner@acme.com") {
	const { repo, svc } = setup();
	const { actor } = await ownerActor(repo, { email });
	const p = await svc.projects.create(actor, { name: "App", baseLocale: "en" });
	await svc.locales.add(actor, p.id, "fr");
	return { repo, svc, actor, projectId: p.id };
}

describe("branches are copy-on-write over their parent", () => {
	it("a branch write is isolated from main; unwritten cells fall through", async () => {
		const { repo, svc, actor, projectId } = await project();
		const key = await svc.keys.create(actor, projectId, {
			name: "greeting",
			baseValue: "Hello",
		});
		await svc.translations.set(actor, projectId, "fr", {
			name: "greeting",
			value: "Bonjour",
		});
		const branch = await svc.branches.create(actor, projectId, {
			name: "feature",
		});
		expect(branch.parentBranchId).toBe(MAIN_BRANCH_ID);
		expect(branch.forkPoint).toBeTruthy();

		// unwritten on the branch → resolves through to main's cell
		expect(
			(await repo.getCell(projectId, branch.id, key.id, "fr"))?.value,
		).toBe("Bonjour");

		await svc.translations.set(actor, projectId, "fr", {
			name: "greeting",
			value: "Salut",
			branch: branch.id,
		});
		// the branch now owns its value; main is untouched
		expect(
			(await repo.getCell(projectId, branch.id, key.id, "fr"))?.value,
		).toBe("Salut");
		expect(
			(await repo.getCell(projectId, MAIN_BRANCH_ID, key.id, "fr"))?.value,
		).toBe("Bonjour");
	});
});

describe("merge transports a branch's accepted values onto its parent", () => {
	it("a clean merge accepts the child's values on main and spends no budget", async () => {
		const { repo, svc, actor, projectId } = await project();
		const key = await svc.keys.create(actor, projectId, {
			name: "greeting",
			baseValue: "Hello",
		});
		const branch = await svc.branches.create(actor, projectId, {
			name: "feature",
		});
		await svc.translations.set(actor, projectId, "fr", {
			name: "greeting",
			value: "Bonjour",
			branch: branch.id,
		});
		await svc.translations.accept(actor, projectId, "fr", "greeting", {
			branch: branch.id,
		});

		const result = await svc.branches.merge(actor, projectId, branch.id);
		expect(result.merged).toBe(1);
		expect(result.conflicts).toHaveLength(0);
		expect(result.run.trigger).toBe("merge");
		expect(result.run.valueSource).toBe(`branch:${branch.id}`);
		expect(result.run.budgetSpent).toBe(0);
		expect(result.run.status).toBe("done");

		const onMain = await repo.getCell(projectId, MAIN_BRANCH_ID, key.id, "fr");
		expect(onMain?.value).toBe("Bonjour");
		expect(onMain?.lifecycle).toBe("accepted");
		expect((await svc.branches.get(actor, projectId, branch.id)).status).toBe(
			"merged",
		);
	});

	it("a key introduced on the branch merges to main with its value", async () => {
		const { repo, svc, actor, projectId } = await project();
		const branch = await svc.branches.create(actor, projectId, {
			name: "feature",
		});
		const nk = await svc.keys.create(actor, projectId, {
			name: "newkey",
			baseValue: "New",
			branch: branch.id,
		});
		await svc.translations.set(actor, projectId, "fr", {
			name: "newkey",
			value: "Nouveau",
			branch: branch.id,
		});
		await svc.translations.accept(actor, projectId, "fr", "newkey", {
			branch: branch.id,
		});

		// main doesn't know the key yet (its def lives only on the branch)
		expect(
			await repo.getKeyDef(projectId, MAIN_BRANCH_ID, nk.id),
		).toBeUndefined();

		await svc.branches.merge(actor, projectId, branch.id);
		expect((await repo.getKeyDef(projectId, MAIN_BRANCH_ID, nk.id))?.name).toBe(
			"newkey",
		);
		expect(
			(await repo.getCell(projectId, MAIN_BRANCH_ID, nk.id, "fr"))?.value,
		).toBe("Nouveau");
	});

	it("a cell the parent advanced past the fork point conflicts → escalation", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
		try {
			const { repo, svc, actor, projectId } = await project();
			const key = await svc.keys.create(actor, projectId, {
				name: "greeting",
				baseValue: "Hello",
			});
			await svc.translations.set(actor, projectId, "fr", {
				name: "greeting",
				value: "MainFr",
			});
			await svc.translations.accept(actor, projectId, "fr", "greeting");

			vi.setSystemTime(new Date("2026-06-02T00:00:00.000Z"));
			const branch = await svc.branches.create(actor, projectId, {
				name: "feature",
			});
			await svc.translations.set(actor, projectId, "fr", {
				name: "greeting",
				value: "BranchFr",
				branch: branch.id,
			});
			await svc.translations.accept(actor, projectId, "fr", "greeting", {
				branch: branch.id,
			});

			// main advances the SAME cell past the fork point
			vi.setSystemTime(new Date("2026-06-03T00:00:00.000Z"));
			await svc.translations.set(actor, projectId, "fr", {
				name: "greeting",
				value: "MainFr2",
			});
			await svc.translations.accept(actor, projectId, "fr", "greeting");

			vi.setSystemTime(new Date("2026-06-04T00:00:00.000Z"));
			const result = await svc.branches.merge(actor, projectId, branch.id);
			expect(result.merged).toBe(0);
			expect(result.conflicts).toHaveLength(1);
			expect(result.conflicts[0]?.keyId).toBe(key.id);
			expect(result.run.status).toBe("partial");

			// main keeps its own value — the branch never overwrote it
			expect(
				(await repo.getCell(projectId, MAIN_BRANCH_ID, key.id, "fr"))?.value,
			).toBe("MainFr2");
			// the conflict is surfaced as a normal open escalation
			expect(
				await svc.escalations.list(actor, projectId, { status: "open" }),
			).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("releases pin a branch immutably", () => {
	it("materializes accepted cells, supersedes the prior release, and get carries entries", async () => {
		const { svc, actor, projectId } = await project();
		const key = await svc.keys.create(actor, projectId, {
			name: "greeting",
			baseValue: "Hello",
		});
		await svc.translations.set(actor, projectId, "fr", {
			name: "greeting",
			value: "Bonjour",
		});
		await svc.translations.accept(actor, projectId, "fr", "greeting");

		const r1 = await svc.releases.create(actor, projectId, {
			label: "v1",
			locales: ["fr"],
		});
		expect(r1.status).toBe("open");
		expect(r1.entries).toEqual([
			{ keyId: key.id, locale: "fr", versionRef: 1 },
		]);

		// cutting a newer release supersedes the prior open one on the same branch
		const r2 = await svc.releases.create(actor, projectId, {
			label: "v2",
			locales: ["fr"],
		});
		const list = await svc.releases.list(actor, projectId);
		expect(list.find((r) => r.id === r1.id)?.status).toBe("superseded");
		expect(list.find((r) => r.id === r2.id)?.status).toBe("open");
		// the list view omits entries; get reassembles them
		expect(list.find((r) => r.id === r2.id)?.entries).toEqual([]);
		expect(
			(await svc.releases.get(actor, projectId, r2.id)).entries,
		).toHaveLength(1);

		// the superseded release is immutable — its pinned entries are unchanged
		const r1After = await svc.releases.get(actor, projectId, r1.id);
		expect(r1After.status).toBe("superseded");
		expect(r1After.entries).toEqual([
			{ keyId: key.id, locale: "fr", versionRef: 1 },
		]);
	});
});

describe("field reports reopen a cell and compound context", () => {
	it("filing reopens the accepted cell; resolving spawns a reusable example", async () => {
		const { repo, svc, actor, projectId } = await project();
		const key = await svc.keys.create(actor, projectId, {
			name: "greeting",
			baseValue: "Hello",
		});
		await svc.translations.set(actor, projectId, "fr", {
			name: "greeting",
			value: "Bonjour",
		});
		await svc.translations.accept(actor, projectId, "fr", "greeting");

		const report = await svc.fieldReports.file(actor, projectId, {
			locale: "fr",
			name: "greeting",
			description: "wrong tone",
		});
		expect(report.status).toBe("open");

		// the cell reopened (accepted → proposed) and re-entered the router
		const reopened = await repo.getCell(
			projectId,
			MAIN_BRANCH_ID,
			key.id,
			"fr",
		);
		expect(reopened?.lifecycle).toBe("proposed");
		expect(reopened?.stale).toBe(true);

		// a run applies the fix and re-accepts
		await svc.translations.set(actor, projectId, "fr", {
			name: "greeting",
			value: "Salut",
		});
		await svc.translations.accept(actor, projectId, "fr", "greeting");

		// resolving spawns a gold example from the correction
		const resolved = await svc.fieldReports.resolve(
			actor,
			projectId,
			report.id,
			{ spawnExample: true },
		);
		expect(resolved.status).toBe("resolved");
		expect(resolved.resolution?.spawnedExampleRef).toMatch(/^ex_/);
		const examples = await svc.examples.find(
			actor,
			projectId,
			"fr",
			"greeting",
		);
		expect(examples.map((e) => e.targetText)).toContain("Salut");
	});

	it("resolving an already-resolved report conflicts", async () => {
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
		const report = await svc.fieldReports.file(actor, projectId, {
			locale: "fr",
			name: "greeting",
			description: "x",
		});
		await svc.fieldReports.resolve(actor, projectId, report.id, {});
		await expect(
			svc.fieldReports.resolve(actor, projectId, report.id, {}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});
});
