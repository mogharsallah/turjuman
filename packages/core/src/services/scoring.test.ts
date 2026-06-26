import { describe, expect, it } from "vitest";
import type { Actor, ProjectRole, Translation, TranslationOrigin } from "@turjuman/schema";
import { AppError } from "@turjuman/core";
import { SCORE_PROMPT_VERSION } from "@turjuman/schema/scoring";
import { FakeRepo } from "../testing/fake-repo.js";
import { QaService } from "./qa.js";
import { ScoringService } from "./scoring.js";

/**
 * Hermetic tests for the AI-scoring service over an in-memory repository. The
 * routing matrix (the core proof) plus provenance, config, prompt assembly, the
 * review queue, RBAC, and tenant isolation. The grading model is BYO and never
 * runs here — these tests submit scores directly, exactly as a connected agent would.
 */

const ORG = "org_main";

interface SeedOpts {
  autoApprove?: boolean;
  threshold?: number;
  guidance?: string;
  origin?: TranslationOrigin;
  status?: Translation["status"];
  value?: string;
}

function actor(globalRole: Actor["globalRole"], userId: string): Actor {
  return { userId, orgId: ORG, globalRole };
}

/** A project (base "en") + locale "fr" + one key + one fr translation, plus actors. */
async function seed(opts: SeedOpts = {}) {
  const repo = new FakeRepo();
  const svc = new ScoringService(repo);
  const projectId = "proj_1";
  const now = "2026-01-01T00:00:00.000Z";
  repo.projects.set(projectId, {
    id: projectId,
    orgId: ORG,
    name: "App",
    slug: "app",
    baseLocale: "en",
    createdAt: now,
    updatedAt: now,
  });
  for (const code of ["en", "fr"]) {
    repo.locales.set(`${projectId}#${code}`, { projectId, code, createdAt: now });
  }
  await repo.putKey({
    projectId,
    namespace: "default",
    name: "greeting",
    plural: false,
    tags: [],
    state: "active",
    createdAt: now,
    updatedAt: now,
  });
  await repo.putTranslation({
    projectId,
    localeCode: "en",
    namespace: "default",
    keyName: "greeting",
    value: "Hello",
    status: "approved",
    updatedBy: "u_owner",
    updatedAt: now,
  });
  await repo.putTranslation({
    projectId,
    localeCode: "fr",
    namespace: "default",
    keyName: "greeting",
    value: opts.value ?? "Bonjour",
    status: opts.status ?? "translated",
    origin: opts.origin ?? "llm",
    sourceRef: "Hello",
    updatedBy: "u_editor",
    updatedAt: now,
  });
  if (opts.autoApprove !== undefined || opts.threshold !== undefined || opts.guidance !== undefined) {
    repo.scoreConfigs.set(projectId, {
      projectId,
      threshold: opts.threshold ?? 90,
      autoApprove: opts.autoApprove ?? false,
      guidance: opts.guidance,
      updatedBy: "u_owner",
      updatedAt: now,
    });
  }
  const owner = actor("OWNER", "u_owner"); // acts as MANAGER → has translation.review
  const setRole = (userId: string, role: ProjectRole) =>
    repo.memberships.set(`${projectId}#${userId}`, { projectId, userId, role, createdAt: now });
  return { repo, svc, projectId, owner, setRole };
}

const member = (userId: string) => actor("MEMBER", userId);

describe("ScoringService routing matrix", () => {
  it("a score below the threshold flags needs_review and stamps provenance", async () => {
    const { svc, projectId, owner } = await seed({ threshold: 90, autoApprove: true });
    const t = await svc.score(owner, projectId, "fr", {
      name: "greeting",
      score: 55,
      comment: "Tone off",
      model: "claude-test",
    });
    expect(t.status).toBe("needs_review");
    expect(t.score).toBe(55);
    expect(t.scoreComment).toBe("Tone off");
    expect(t.scoredBy).toBe("u_owner");
    expect(t.scoreModel).toBe("claude-test");
    expect(t.promptVersion).toBe(SCORE_PROMPT_VERSION);
    expect(t.scoredAt).toBeDefined();
    // A low score does not promote.
    expect(t.approvedValue).toBeUndefined();
  });

  it("a high score auto-approves machine work when opted in and the actor can review", async () => {
    const { svc, projectId, owner } = await seed({ threshold: 90, autoApprove: true, origin: "llm" });
    const t = await svc.score(owner, projectId, "fr", { name: "greeting", score: 95 });
    expect(t.status).toBe("approved");
    expect(t.approvedValue).toBe("Bonjour"); // working value promoted to the shipped snapshot
  });

  it("a high score does NOT auto-approve when the actor lacks the review permission", async () => {
    const { svc, projectId, setRole } = await seed({ threshold: 90, autoApprove: true });
    setRole("u_dev", "DEVELOPER"); // DEVELOPER has translation.write but not translation.review
    const t = await svc.score(member("u_dev"), projectId, "fr", { name: "greeting", score: 95 });
    expect(t.status).toBe("translated");
    expect(t.approvedValue).toBeUndefined();
  });

  it("a high score does NOT auto-approve when auto-approve is off", async () => {
    const { svc, projectId, owner } = await seed({ threshold: 90, autoApprove: false });
    const t = await svc.score(owner, projectId, "fr", { name: "greeting", score: 95 });
    expect(t.status).toBe("translated");
  });

  it("a high score NEVER auto-approves human-origin work", async () => {
    const { svc, projectId, owner } = await seed({ threshold: 90, autoApprove: true, origin: "human" });
    const t = await svc.score(owner, projectId, "fr", { name: "greeting", score: 99 });
    expect(t.status).toBe("translated");
    expect(t.approvedValue).toBeUndefined();
  });

  it("uses the default config (threshold 90, auto-approve off) when none is set", async () => {
    const { svc, projectId, owner } = await seed(); // no config row
    const high = await svc.score(owner, projectId, "fr", { name: "greeting", score: 90 });
    expect(high.status).toBe("translated"); // at threshold but auto-approve defaults off
    const low = await svc.score(owner, projectId, "fr", { name: "greeting", score: 89 });
    expect(low.status).toBe("needs_review");
  });
});

describe("ScoringService provenance + config", () => {
  it("stamps a +custom prompt version when the project sets evaluation guidance", async () => {
    const { svc, projectId, owner } = await seed({ guidance: "Prefer formal register." });
    const t = await svc.score(owner, projectId, "fr", { name: "greeting", score: 50 });
    expect(t.promptVersion).toBe(`${SCORE_PROMPT_VERSION}+custom`);
  });

  it("getConfig returns defaults; setConfig persists and round-trips", async () => {
    const { svc, projectId, owner } = await seed();
    expect(await svc.getConfig(owner, projectId)).toMatchObject({ threshold: 90, autoApprove: false });
    const saved = await svc.setConfig(owner, projectId, {
      threshold: 80,
      autoApprove: true,
      guidance: "Keep it punchy.",
    });
    expect(saved).toMatchObject({ threshold: 80, autoApprove: true, guidance: "Keep it punchy." });
    expect(await svc.getConfig(owner, projectId)).toMatchObject({ threshold: 80, autoApprove: true });
  });

  it("setConfig rejects an out-of-range threshold", async () => {
    const { svc, projectId, owner } = await seed();
    await expect(svc.setConfig(owner, projectId, { threshold: 150 })).rejects.toBeInstanceOf(AppError);
  });

  it("score rejects a non-integer / out-of-range score", async () => {
    const { svc, projectId, owner } = await seed();
    await expect(svc.score(owner, projectId, "fr", { name: "greeting", score: 120 })).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it("a re-score overwrites the prior score (no history)", async () => {
    const { svc, projectId, owner } = await seed({ threshold: 90 });
    await svc.score(owner, projectId, "fr", { name: "greeting", score: 40, comment: "first" });
    const second = await svc.score(owner, projectId, "fr", { name: "greeting", score: 95, comment: "second" });
    expect(second.score).toBe(95);
    expect(second.scoreComment).toBe("second");
  });
});

describe("ScoringService prompt assembly", () => {
  it("assembles a prompt with the rubric, guidance, glossary, source and target", async () => {
    const { repo, svc, projectId, owner } = await seed({ guidance: "Use vous, not tu." });
    repo.glossary.set(projectId, [
      {
        projectId,
        id: "g1",
        term: "Hello",
        translations: { fr: "Bonjour" },
        caseSensitive: false,
        doNotTranslate: false,
        createdAt: "x",
        updatedAt: "x",
      },
    ]);
    const prompt = await svc.buildScorePrompt(owner, projectId, "fr", { name: "greeting" });
    const text = prompt.messages.map((m) => m.text).join("\n");
    expect(text).toContain("MQM");
    expect(text).toContain("Use vous, not tu.");
    expect(text).toContain("Hello");
    expect(text).toContain("Bonjour");
    expect(prompt.promptVersion).toBe(`${SCORE_PROMPT_VERSION}+custom`);
  });

  it("refuses to score the base locale against itself", async () => {
    const { svc, projectId, owner } = await seed();
    await expect(svc.buildScorePrompt(owner, projectId, "en", { name: "greeting" })).rejects.toBeInstanceOf(
      AppError,
    );
  });
});

describe("ScoringService guards", () => {
  it("refuses to score a translation that has no value yet", async () => {
    const { svc, projectId, owner } = await seed({ value: "" });
    await expect(
      svc.score(owner, projectId, "fr", { name: "greeting", score: 95 }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("refuses to score the base locale (score path matches the prompt path)", async () => {
    const { svc, projectId, owner } = await seed();
    await expect(
      svc.score(owner, projectId, "en", { name: "greeting", score: 95 }),
    ).rejects.toBeInstanceOf(AppError);
    await expect(
      svc.reviewBatch(owner, projectId, "en", [{ name: "greeting", score: 95 }]),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("reviewBatch skips entries whose translation has no value", async () => {
    const { repo, svc, projectId, owner } = await seed({ threshold: 90, autoApprove: true });
    await repo.putTranslation({
      projectId,
      localeCode: "fr",
      namespace: "default",
      keyName: "blank",
      value: "   ",
      status: "translated",
      origin: "llm",
      updatedBy: "u_editor",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await repo.putKey({
      projectId,
      namespace: "default",
      name: "blank",
      plural: false,
      tags: [],
      state: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const result = await svc.reviewBatch(owner, projectId, "fr", [
      { name: "greeting", score: 95 },
      { name: "blank", score: 95 },
    ]);
    expect(result.written).toBe(1);
    expect(result.skipped).toEqual(["default#blank"]);
  });
});

describe("ScoringService review queue + batch", () => {
  it("listForReviewPage surfaces only needs_review keys", async () => {
    const { svc, projectId, owner } = await seed({ threshold: 90 });
    await svc.score(owner, projectId, "fr", { name: "greeting", score: 30 });
    const page = await svc.listForReviewPage(owner, projectId, "fr");
    expect(page.keys.map((k) => k.name)).toEqual(["greeting"]);
  });

  it("reviewBatch routes each entry and reports counts + skips unknown keys", async () => {
    const { svc, projectId, owner } = await seed({ threshold: 90, autoApprove: true });
    const result = await svc.reviewBatch(owner, projectId, "fr", [
      { name: "greeting", score: 95 }, // → approved
      { name: "ghost", score: 95 }, // unknown → skipped
    ]);
    expect(result).toMatchObject({ written: 1, approved: 1, flagged: 0 });
    expect(result.skipped).toEqual(["default#ghost"]);
  });

  it("reviewBatch collapses duplicate keys (last score wins, counted once)", async () => {
    const { repo, svc, projectId, owner } = await seed({ threshold: 90, autoApprove: true });
    const result = await svc.reviewBatch(owner, projectId, "fr", [
      { name: "greeting", score: 30 }, // would flag
      { name: "greeting", score: 95 }, // last wins → approved
    ]);
    expect(result).toMatchObject({ written: 1, approved: 1, flagged: 0 });
    const t = await repo.getTranslation(projectId, "fr", "default", "greeting");
    expect(t?.score).toBe(95);
    expect(t?.status).toBe("approved");
  });

  it("buildScorePrompt batch renders every active key on the page", async () => {
    const { repo, svc, projectId, owner } = await seed();
    const now = "2026-01-01T00:00:00.000Z";
    await repo.putKey({
      projectId, namespace: "default", name: "farewell", plural: false, tags: [], state: "active", createdAt: now, updatedAt: now,
    });
    await repo.putTranslation({
      projectId, localeCode: "en", namespace: "default", keyName: "farewell", value: "Bye", status: "approved", updatedBy: "u", updatedAt: now,
    });
    await repo.putTranslation({
      projectId, localeCode: "fr", namespace: "default", keyName: "farewell", value: "Au revoir", status: "translated", origin: "llm", updatedBy: "u", updatedAt: now,
    });
    const prompt = await svc.buildScorePrompt(owner, projectId, "fr", {});
    const text = prompt.messages.map((m) => m.text).join("\n");
    expect(text).toContain("default#greeting");
    expect(text).toContain("default#farewell");
    expect(text).toContain("Au revoir");
  });
});

describe("needs_review and the QA engine", () => {
  it("treats a needs_review value as expected (the empty check fires when it is blank)", async () => {
    const { repo, svc, projectId, owner } = await seed();
    // A flagged-but-blank value: the QA `empty` check keys off the service-derived
    // `expectsValue`, which must now include needs_review.
    await repo.putTranslation({
      projectId,
      localeCode: "fr",
      namespace: "default",
      keyName: "greeting",
      value: "   ",
      status: "needs_review",
      origin: "llm",
      updatedBy: "u_editor",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    void svc; // scoring service unused here; we exercise QA over the same repo
    const qa = new QaService(repo);
    const report = await qa.run(owner, projectId, { locale: "fr", checkIds: ["empty"] });
    expect(report.findings.some((f) => f.checkId === "empty" && f.keyName === "greeting")).toBe(true);
  });
});

describe("ScoringService authorization", () => {
  it("denies scoring to a VIEWER (no translation.write)", async () => {
    const { svc, projectId, setRole } = await seed();
    setRole("u_view", "VIEWER");
    await expect(svc.score(member("u_view"), projectId, "fr", { name: "greeting", score: 95 })).rejects.toThrow();
  });

  it("isolates tenants — an actor from another org cannot see the project", async () => {
    const { svc, projectId } = await seed();
    const outsider: Actor = { userId: "u_x", orgId: "org_other", globalRole: "OWNER" };
    await expect(svc.score(outsider, projectId, "fr", { name: "greeting", score: 95 })).rejects.toThrow();
  });
});
