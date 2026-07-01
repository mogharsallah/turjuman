import type { Actor } from "@turjuman/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticate } from "./auth.js";
import type { TurjumanService } from "./services/index.js";
import { type FakeRepo, ownerActor, setup } from "./testing/fake-repo.js";

/**
 * Layer 4 — RBAC at the *service* seam (TESTING.md). The pure (role × action)
 * matrix is asserted in `@turjuman/schema`'s `rbac.test.ts`; this proves the
 * services actually run every mutation through that matrix by using the one
 * credential that denies *every* non-`.read` action regardless of role: a
 * **read-only API key** (`{ readOnly: true }`).
 *
 * The probe is an OWNER's read-only key. An OWNER otherwise acts as MANAGER on
 * every project and holds every org permission, so a FORBIDDEN here can only come
 * from the read-only gate (`deniedByReadOnly`) — not from a missing role. If a
 * service method forgot its `authorizeProject`/`requireOrg` preamble, the
 * mutation would slip through and the loop turns red.
 *
 * This is a **guarded** loop, not a blind one. The independent oracle is the
 * hand-authored `DENIED` table below (one entry per mutating capability, each
 * naming the operation it stands for); a by-design **allowlist** of ungated
 * self-target operations is asserted separately so its exemption is pinned, not
 * silently skipped. Per-resource nuance (last-owner demotion, privilege
 * escalation) stays bespoke in `services.test.ts`.
 */

// A fixed clock: the allowlisted writes below stamp `createdAt`, and TESTING.md
// requires a pinned clock in any suite that touches `Date`.
beforeEach(() => vi.setSystemTime(new Date("2026-06-26T00:00:00.000Z")));
afterEach(() => vi.useRealTimers());

/** Build an OWNER, a project, and that OWNER's *read-only* actor over it. */
async function readOnlySetup(): Promise<{
	repo: FakeRepo;
	svc: TurjumanService;
	owner: Actor;
	ro: Actor;
	projectId: string;
}> {
	const { repo, svc } = setup();
	const { actor: owner } = await ownerActor(repo);
	const project = await svc.projects.create(owner, {
		name: "App",
		baseLocale: "en",
	});
	// Mint a read-only key for the OWNER and authenticate as it — same user, same
	// org, same (MANAGER-everywhere) role, but `readOnly` flips on.
	const { secret } = await svc.apiKeys.create(owner, {
		name: "ci",
		readOnly: true,
	});
	const ro = (await authenticate(repo, secret))!.actor;
	return { repo, svc, owner, ro, projectId: project.id };
}

interface DeniedCase {
	/** The SDK operation this service call backs (coverage intent + failure label). */
	op: string;
	/** The RBAC action whose gate must reject a read-only key. */
	action: string;
	/** Invoke the mutating service method with the read-only actor. */
	call: (
		svc: TurjumanService,
		ro: Actor,
		projectId: string,
	) => Promise<unknown>;
}

// Hand-authored — the independent oracle. One row per mutating capability the
// read-only gate must deny. The project/locale/key/term ids need not exist: every
// mutation runs `authorizeProject`/`requireOrg` *before* any resource lookup, so
// the read-only denial fires first (project-scoped calls do need the project to
// exist, which `readOnlySetup` guarantees, since NOT_FOUND precedes FORBIDDEN).
//
// Why hand-maintained and not derived from the `@turjuman/sdk` registry's
// `readOnlyHint`: this test lives in `core`, and `sdk` depends on `core` (never
// the reverse), so `OPERATIONS` isn't importable here. Adding a new mutating
// capability therefore needs a row here by hand — keep this list in lockstep with
// new `core/services` mutations (the sdk-side registry completeness is gated
// separately by `sdk/src/operations.test.ts`).
const DENIED: DeniedCase[] = [
	// ---- org-scoped --------------------------------------------------------------
	{
		op: "create_project",
		action: "project.create",
		call: (s, ro) => s.projects.create(ro, { name: "Nope", baseLocale: "en" }),
	},
	{
		op: "create_user",
		action: "user.manage",
		call: (s, ro) => s.users.create(ro, { email: "x@acme.com", name: "X" }),
	},
	{
		op: "set_user_role",
		action: "user.manage",
		call: (s, ro) => s.users.setGlobalRole(ro, "user_x", "MEMBER"),
	},
	// ---- project lifecycle -------------------------------------------------------
	{
		op: "update_project",
		action: "project.update",
		call: (s, ro, p) => s.projects.update(ro, p, { name: "X" }),
	},
	{
		op: "delete_project",
		action: "project.delete",
		call: (s, ro, p) => s.projects.delete(ro, p, true),
	},
	// ---- locales -----------------------------------------------------------------
	{
		op: "add_locale",
		action: "locale.manage",
		call: (s, ro, p) => s.locales.add(ro, p, "de"),
	},
	// ---- keys --------------------------------------------------------------------
	{
		op: "create_key",
		action: "key.manage",
		call: (s, ro, p) => s.keys.create(ro, p, { name: "k" }),
	},
	{
		op: "update_key",
		action: "key.manage",
		call: (s, ro, p) => s.keys.update(ro, p, "k", { description: "d" }),
	},
	{
		op: "delete_key",
		action: "key.manage",
		call: (s, ro, p) => s.keys.delete(ro, p, "k", true),
	},
	{
		op: "rename_key",
		action: "key.manage",
		call: (s, ro, p) => s.keys.rename(ro, p, "k", { name: "k2" }),
	},
	{
		op: "import_keys (CLI)",
		action: "key.manage",
		call: (s, ro, p) => s.keys.import(ro, p, [{ name: "k" }]),
	},
	// ---- translations ------------------------------------------------------------
	{
		op: "set_translation",
		action: "translation.write",
		call: (s, ro, p) =>
			s.translations.set(ro, p, "en", { name: "k", value: "v" }),
	},
	{
		op: "bulk_set_translations",
		action: "translation.write",
		call: (s, ro, p) =>
			s.translations.bulkSet(ro, p, "en", [{ name: "k", value: "v" }]),
	},
	{
		op: "accept_translation",
		action: "translation.review",
		call: (s, ro, p) => s.translations.accept(ro, p, "en", "k", {}),
	},
	// ---- glossary ----------------------------------------------------------------
	{
		op: "add_glossary_term",
		action: "glossary.manage",
		call: (s, ro, p) => s.glossary.add(ro, p, { term: "t" }),
	},
	{
		op: "update_glossary_term",
		action: "glossary.manage",
		call: (s, ro, p) => s.glossary.update(ro, p, "tid", { notes: "n" }),
	},
	{
		op: "remove_glossary_term",
		action: "glossary.manage",
		call: (s, ro, p) => s.glossary.remove(ro, p, "tid"),
	},
	// ---- context rules + examples ------------------------------------------------
	{
		op: "create_context_rule",
		action: "glossary.manage",
		call: (s, ro, p) => s.context.createRule(ro, p, { kind: "voice" }),
	},
	{
		op: "update_context_rule",
		action: "glossary.manage",
		call: (s, ro, p) => s.context.updateRule(ro, p, "ctx_x", { hard: true }),
	},
	{
		op: "delete_context_rule",
		action: "glossary.manage",
		call: (s, ro, p) => s.context.deleteRule(ro, p, "ctx_x"),
	},
	{
		op: "add_example",
		action: "glossary.manage",
		call: (s, ro, p) =>
			s.examples.add(ro, p, {
				locale: "en",
				sourceText: "s",
				targetText: "t",
			}),
	},
	{
		op: "remove_example",
		action: "glossary.manage",
		call: (s, ro, p) => s.examples.remove(ro, p, "ex_x"),
	},
	// ---- escalations -------------------------------------------------------------
	{
		op: "escalate_translation",
		action: "translation.review",
		call: (s, ro, p) => s.escalations.open(ro, p, "en", "k", { reason: "r" }),
	},
	{
		op: "claim_escalation",
		action: "translation.review",
		call: (s, ro, p) => s.escalations.claim(ro, p, "esc_x"),
	},
	{
		op: "resolve_escalation",
		action: "translation.review",
		call: (s, ro, p) => s.escalations.resolve(ro, p, "esc_x", {}),
	},
	// ---- comments ----------------------------------------------------------------
	{
		op: "add_comment",
		action: "translation.write",
		call: (s, ro, p) => s.comments.add(ro, p, "en", "k", { body: "b" }),
	},
	// ---- webhooks ----------------------------------------------------------------
	{
		op: "add_webhook",
		action: "webhook.manage",
		call: (s, ro, p) =>
			s.webhooks.add(ro, p, { url: "https://e.co/h", events: ["key.created"] }),
	},
	{
		op: "remove_webhook",
		action: "webhook.manage",
		call: (s, ro, p) => s.webhooks.remove(ro, p, "wid"),
	},
	// ---- members -----------------------------------------------------------------
	{
		op: "add_member",
		action: "member.manage",
		call: (s, ro, p) => s.members.add(ro, p, { userId: "user_x" }, "EDITOR"),
	},
	{
		op: "set_member_role",
		action: "member.manage",
		call: (s, ro, p) => s.members.setRole(ro, p, "user_x", "EDITOR"),
	},
	{
		op: "remove_member",
		action: "member.manage",
		call: (s, ro, p) => s.members.remove(ro, p, "user_x"),
	},
	// ---- QA config ---------------------------------------------------------------
	{
		op: "set_qa_config",
		action: "project.update",
		call: (s, ro, p) =>
			s.qa.setConfig(ro, p, { checks: { empty: { enabled: false } } }),
	},
	// ---- namespaces --------------------------------------------------------------
	{
		op: "create_namespace",
		action: "key.manage",
		call: (s, ro, p) => s.namespaces.create(ro, p, { name: "ns" }),
	},
	{
		op: "update_namespace",
		action: "key.manage",
		call: (s, ro, p) => s.namespaces.update(ro, p, "nsid", { title: "t" }),
	},
	// ---- runs --------------------------------------------------------------------
	{
		op: "start_run",
		action: "translation.write",
		call: (s, ro, p) => s.runs.start(ro, p, {}),
	},
	{
		op: "finish_run",
		action: "translation.write",
		call: (s, ro, p) => s.runs.finish(ro, p, "run_x", {}),
	},
	{
		op: "cancel_run",
		action: "translation.write",
		call: (s, ro, p) => s.runs.cancel(ro, p, "run_x"),
	},
	// ---- branches / releases / field reports -------------------------------------
	{
		op: "create_branch",
		action: "translation.write",
		call: (s, ro, p) => s.branches.create(ro, p, { name: "feature" }),
	},
	{
		op: "merge_branch",
		action: "translation.review",
		call: (s, ro, p) => s.branches.merge(ro, p, "br_x"),
	},
	{
		op: "create_release",
		action: "translation.write",
		call: (s, ro, p) => s.releases.create(ro, p, { label: "v1" }),
	},
	{
		op: "file_field_report",
		action: "translation.write",
		call: (s, ro, p) =>
			s.fieldReports.file(ro, p, {
				locale: "en",
				name: "k",
				description: "wrong",
			}),
	},
	{
		op: "resolve_field_report",
		action: "translation.review",
		call: (s, ro, p) => s.fieldReports.resolve(ro, p, "fr_x", {}),
	},
];

describe("RBAC service seam — a read-only key is denied every mutation", () => {
	describe.each(DENIED)("$op ($action)", ({ call }) => {
		it("rejects with FORBIDDEN", async () => {
			const { svc, ro, projectId } = await readOnlySetup();
			await expect(call(svc, ro, projectId)).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
		});
	});

	// Meta-assertion on the read-only probe itself: it must read freely, so a
	// FORBIDDEN above can only mean "mutation denied", never "this key can't see
	// the project at all". Without this, a probe that denied *everything* would
	// make the whole loop vacuously green.
	it("the read-only probe can still READ the project (so denials mean what they say)", async () => {
		const { svc, ro, projectId } = await readOnlySetup();
		await expect(svc.projects.get(ro, projectId)).resolves.toMatchObject({
			id: projectId,
		});
		await expect(svc.keys.list(ro, projectId)).resolves.toEqual([]);
		await expect(svc.projects.list(ro)).resolves.toHaveLength(1);
	});
});

describe("RBAC service seam — by-design ungated exceptions (allowlist)", () => {
	// A user may ALWAYS manage their OWN keys: self-target create/revoke run no
	// `requireOrg`/`requireProject` gate, so the read-only flag never engages.
	// Pinning the actual behaviour keeps this exemption visible — a future gate
	// added here would flip these from resolve to throw and fail loudly.
	it("create_api_key for SELF is allowed even for a read-only key", async () => {
		const { svc, ro } = await readOnlySetup();
		const minted = await svc.apiKeys.create(ro, { name: "self" });
		expect(minted.secret).toBeTruthy();
	});

	it("revoke_api_key for SELF is allowed even for a read-only key", async () => {
		const { svc, owner, ro } = await readOnlySetup();
		// The owner mints a second self-key; the read-only actor (same user) revokes it.
		const victim = await svc.apiKeys.create(owner, { name: "victim" });
		await expect(svc.apiKeys.revoke(ro, victim.apiKey.id)).resolves.toEqual({
			revoked: victim.apiKey.id,
		});
	});
});
