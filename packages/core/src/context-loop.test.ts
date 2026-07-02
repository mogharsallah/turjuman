import { MAIN_BRANCH_ID } from "@turjuman/schema";
import { describe, expect, it } from "vitest";
import { ownerActor, setup } from "./testing/fake-repo.js";

/**
 * Hermetic coverage of the Batch 2 context + agent loop, proven against the
 * in-memory {@link FakeRepo}. The pure fold algebra is unit-tested in
 * `schema/cascade.test.ts`; this asserts the *service* wiring the cascade hangs
 * off — the brief, the context-change staleness fan-out, deterministic example
 * retrieval, the escalation router (open → claim CAS → resolve + spawn), and
 * scoped glossary/comments.
 */

async function project(email = "owner@acme.com") {
	const { repo, svc } = setup();
	const { actor } = await ownerActor(repo, { email });
	const p = await svc.projects.create(actor, { name: "App", baseLocale: "en" });
	await svc.locales.add(actor, p.id, "fr");
	return { repo, svc, actor, projectId: p.id };
}

describe("the brief resolves the cascade for a key × locale", () => {
	it("carries the key, base value, voice, and the locale shape", async () => {
		const { svc, actor, projectId } = await project();
		await svc.keys.create(actor, projectId, {
			name: "checkout.pay",
			namespace: "checkout",
			baseValue: "Pay now",
		});
		await svc.context.createRule(actor, projectId, {
			kind: "voice",
			payload: { tone: "terse" },
		});
		const brief = await svc.context.brief(
			actor,
			projectId,
			"fr",
			"checkout.pay",
			{
				namespace: "checkout",
			},
		);
		expect(brief.key.name).toBe("checkout.pay");
		expect(brief.baseValue).toBe("Pay now");
		expect(brief.context.voice).toEqual({ tone: "terse" });
		expect(brief.context.shape.locale).toBe("fr");
		expect(brief.context.shape.pluralCategories).toContain("other");
		expect(brief.context.reviewDepth).toBe("normal");
	});

	it("a key-scoped voice overrides the project voice and raises review depth", async () => {
		const { svc, actor, projectId } = await project();
		const key = await svc.keys.create(actor, projectId, {
			name: "greeting",
			baseValue: "Hello",
		});
		await svc.context.createRule(actor, projectId, {
			kind: "voice",
			payload: { tone: "neutral", formality: "formal" },
		});
		await svc.context.createRule(actor, projectId, {
			kind: "voice",
			scope: { keyId: key.id },
			payload: { tone: "playful" },
		});
		const ctx = await svc.context.resolve(actor, projectId, "fr", "greeting");
		expect(ctx.voice).toEqual({ tone: "playful", formality: "formal" });
		expect(ctx.reviewDepth).toBe("raised");
		expect(ctx.provenance[0]).toMatchObject({
			field: "voice",
			tier: "key×all",
			crossTierOverride: true,
		});
	});
});

describe("a scoped context write stales its dependents", () => {
	it("bumps contextRevision and marks the key's translated cells stale", async () => {
		const { svc, actor, projectId } = await project();
		const key = await svc.keys.create(actor, projectId, {
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
		const before = (await svc.projects.get(actor, projectId)).contextRevision;

		await svc.context.createRule(actor, projectId, {
			kind: "voice",
			scope: { keyId: key.id },
			payload: { tone: "warm" },
		});

		expect((await svc.projects.get(actor, projectId)).contextRevision).toBe(
			before + 1,
		);
		const stale = await svc.translations.listStale(actor, projectId, "fr");
		expect(stale.map((k) => k.name)).toEqual(["greeting"]);
	});

	it("re-translating clears context staleness", async () => {
		const { svc, actor, projectId } = await project();
		const key = await svc.keys.create(actor, projectId, {
			name: "greeting",
			baseValue: "Hello",
		});
		await svc.translations.set(actor, projectId, "fr", {
			name: "greeting",
			value: "Bonjour",
		});
		await svc.context.createRule(actor, projectId, {
			kind: "voice",
			scope: { keyId: key.id },
			payload: { tone: "warm" },
		});
		expect(
			await svc.translations.listStale(actor, projectId, "fr"),
		).toHaveLength(1);
		await svc.translations.set(actor, projectId, "fr", {
			name: "greeting",
			value: "Salut",
		});
		expect(
			await svc.translations.listStale(actor, projectId, "fr"),
		).toHaveLength(0);
	});
});

describe("glossary terms carry scope and surface in the resolved cascade", () => {
	it("a project-wide term appears, defaulting to active lifecycle", async () => {
		const { svc, actor, projectId } = await project();
		await svc.keys.create(actor, projectId, {
			name: "greeting",
			baseValue: "Hello",
		});
		await svc.glossary.add(actor, projectId, {
			term: "cart",
			translations: { fr: "panier" },
		});
		const ctx = await svc.context.resolve(actor, projectId, "fr", "greeting");
		expect(ctx.glossary.map((g) => g.term)).toContain("cart");
		expect(ctx.glossary[0]?.lifecycle).toBe("active");
	});
});

describe("examples retrieve deterministically for a key × locale", () => {
	it("ranks a key-scoped gold example ahead of a project one", async () => {
		const { svc, actor, projectId } = await project();
		const key = await svc.keys.create(actor, projectId, {
			name: "greeting",
			baseValue: "Hello",
		});
		await svc.examples.add(actor, projectId, {
			locale: "fr",
			sourceText: "Hi",
			targetText: "ProjBonjour",
			quality: "accepted",
		});
		await svc.examples.add(actor, projectId, {
			locale: "fr",
			scope: { keyId: key.id },
			sourceText: "Hi",
			targetText: "KeyBonjour",
			quality: "gold",
		});
		const found = await svc.examples.find(actor, projectId, "fr", "greeting");
		expect(found.map((e) => e.targetText)).toEqual([
			"KeyBonjour",
			"ProjBonjour",
		]);
	});
});

describe("the escalation router", () => {
	it("opens (flips the cell to escalated), claims, then resolves with accept + spawned example", async () => {
		const { repo, svc, actor, projectId } = await project();
		const key = await svc.keys.create(actor, projectId, {
			name: "greeting",
			baseValue: "Hello",
		});
		await svc.translations.set(actor, projectId, "fr", {
			name: "greeting",
			value: "Bonjour?",
		});

		const esc = await svc.escalations.open(actor, projectId, "fr", "greeting", {
			reason: "tone unclear",
		});
		expect(esc.status).toBe("open");
		expect(
			(await repo.getCell(projectId, MAIN_BRANCH_ID, key.id, "fr"))?.lifecycle,
		).toBe("escalated");

		const claimed = await svc.escalations.claim(actor, projectId, esc.id);
		expect(claimed.claimedBy).toBe(actor.userId);

		const resolved = await svc.escalations.resolve(actor, projectId, esc.id, {
			value: "Bonjour",
			spawnExample: true,
		});
		expect(resolved.status).toBe("resolved");
		expect(resolved.resolution?.valueChosen).toBe("Bonjour");
		expect(resolved.resolution?.spawnedExampleRef).toMatch(/^ex_/);

		const accepted = await repo.getCell(
			projectId,
			MAIN_BRANCH_ID,
			key.id,
			"fr",
		);
		expect(accepted?.lifecycle).toBe("accepted");
		expect(accepted?.value).toBe("Bonjour");
		// the human decision compounded into a reusable example
		const examples = await svc.examples.find(
			actor,
			projectId,
			"fr",
			"greeting",
		);
		expect(examples.map((e) => e.targetText)).toContain("Bonjour");
	});

	it("a second claim on a claimed escalation loses with CONFLICT", async () => {
		const { repo, svc, actor, projectId } = await project();
		await svc.keys.create(actor, projectId, {
			name: "greeting",
			baseValue: "Hello",
		});
		await svc.translations.set(actor, projectId, "fr", {
			name: "greeting",
			value: "Bonjour",
		});
		const esc = await svc.escalations.open(actor, projectId, "fr", "greeting", {
			reason: "x",
		});
		const at = new Date().toISOString();
		await repo.claimEscalation(projectId, esc.id, "user_a", at);
		await expect(
			repo.claimEscalation(projectId, esc.id, "user_b", at),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("lists only open escalations when filtered", async () => {
		const { svc, actor, projectId } = await project();
		await svc.keys.create(actor, projectId, {
			name: "greeting",
			baseValue: "Hello",
		});
		await svc.translations.set(actor, projectId, "fr", {
			name: "greeting",
			value: "Bonjour",
		});
		const esc = await svc.escalations.open(actor, projectId, "fr", "greeting", {
			reason: "x",
		});
		await svc.escalations.resolve(actor, projectId, esc.id, { value: "Salut" });
		expect(
			await svc.escalations.list(actor, projectId, { status: "open" }),
		).toHaveLength(0);
		expect(await svc.escalations.list(actor, projectId)).toHaveLength(1);
	});
});

describe("comments thread on a (key, locale) string", () => {
	it("adds threaded comments and lists them", async () => {
		const { svc, actor, projectId } = await project();
		await svc.keys.create(actor, projectId, {
			name: "greeting",
			baseValue: "Hello",
		});
		const root = await svc.comments.add(actor, projectId, "fr", "greeting", {
			body: "too formal",
		});
		await svc.comments.add(actor, projectId, "fr", "greeting", {
			body: "agreed",
			parentId: root.id,
		});
		const list = await svc.comments.list(actor, projectId, "fr", "greeting");
		expect(list.map((c) => c.body).sort()).toEqual(["agreed", "too formal"]);
		expect(list.find((c) => c.body === "agreed")?.parentId).toBe(root.id);
	});
});
