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
  Webhook,
} from "./domain.js";
import {
  glossaryTermSchema,
  localeSchema,
  membershipSchema,
  projectSchema,
  qaConfigSchema,
  userSchema,
  webhookSchema,
} from "./domain.js";
import type { QaReport } from "./qa/types.js";
import {
  apiKeyCreatedSchema,
  apiKeyPublicSchema,
  bulkSetResultSchema,
  bundlePageSchema,
  errorEnvelopeSchema,
  importKeysResultSchema,
  keyPageSchema,
  keyWithTranslationsSchema,
  qaReportSchema,
  translationPageSchema,
  webhookPublicSchema,
} from "./wire.js";

/**
 * Parity guard: the wire schemas (used as MCP `output` schemas and OpenAPI
 * response schemas) must accept exactly what the services return. These tests
 * parse representative service results so any future drift between a domain
 * shape and its documented schema fails here rather than at runtime.
 */

const now = "2026-06-18T00:00:00.000Z";

const sampleKey: TranslationKey = {
  projectId: "proj_1",
  namespace: "default",
  name: "greeting",
  description: "A greeting",
  plural: false,
  maxLength: 40,
  tags: ["ui"],
  state: "active",
  lastSeenAt: now,
  createdAt: now,
  updatedAt: now,
};

const sampleTranslation: Translation = {
  projectId: "proj_1",
  localeCode: "fr",
  namespace: "default",
  keyName: "greeting",
  value: "Bonjour",
  status: "translated",
  origin: "llm",
  updatedBy: "user_1",
  updatedAt: now,
};

describe("wire schemas accept service results", () => {
  it("keyWithTranslationsSchema accepts a key + its translations", () => {
    expect(() =>
      keyWithTranslationsSchema.parse({ key: sampleKey, translations: [sampleTranslation] }),
    ).not.toThrow();
  });

  it("keyPageSchema accepts a page with and without a cursor", () => {
    expect(() => keyPageSchema.parse({ keys: [sampleKey] })).not.toThrow();
    expect(() => keyPageSchema.parse({ keys: [sampleKey], nextCursor: "abc" })).not.toThrow();
  });

  it("translationPageSchema accepts a page of translations", () => {
    expect(() => translationPageSchema.parse({ translations: [sampleTranslation] })).not.toThrow();
  });

  it("bundlePageSchema accepts adapter-ready export rows", () => {
    expect(() =>
      bundlePageSchema.parse({
        entries: [{ key: "greeting", namespace: "default", value: "Bonjour", plural: false }],
      }),
    ).not.toThrow();
  });

  it("importKeysResultSchema accepts an import summary", () => {
    expect(() =>
      importKeysResultSchema.parse({
        created: 1,
        updated: 0,
        reactivated: 0,
        baseValuesSet: 1,
        deleted: 0,
        deprecated: 0,
      }),
    ).not.toThrow();
  });

  it("bulkSetResultSchema accepts a bulk-write summary", () => {
    expect(() => bulkSetResultSchema.parse({ written: 3, skipped: ["missing.key"] })).not.toThrow();
  });

  it("projectSchema accepts a project entity", () => {
    const project: Project = {
      id: "proj_1",
      orgId: "org_1",
      name: "Web app",
      slug: "web-app",
      description: "The web app strings",
      baseLocale: "en",
      createdAt: now,
      updatedAt: now,
    };
    expect(() => projectSchema.parse(project)).not.toThrow();
  });

  it("localeSchema accepts a locale entity", () => {
    const locale: Locale = {
      projectId: "proj_1",
      code: "fr",
      name: "French",
      createdAt: now,
    };
    expect(() => localeSchema.parse(locale)).not.toThrow();
  });

  it("glossaryTermSchema accepts a glossary term", () => {
    const term: GlossaryTerm = {
      projectId: "proj_1",
      id: "gt_1",
      term: "Checkout",
      translations: { fr: "Paiement" },
      caseSensitive: false,
      doNotTranslate: false,
      notes: "The purchase flow",
      createdAt: now,
      updatedAt: now,
    };
    expect(() => glossaryTermSchema.parse(term)).not.toThrow();
  });

  it("webhookSchema accepts a webhook (secret included — admin surface)", () => {
    const hook: Webhook = {
      projectId: "proj_1",
      id: "wh_1",
      url: "https://example.com/hook",
      events: ["*"],
      secret: "whsec_x",
      createdAt: now,
    };
    expect(() => webhookSchema.parse(hook)).not.toThrow();
  });

  it("userSchema accepts a user entity", () => {
    const user: User = {
      id: "user_1",
      orgId: "org_1",
      email: "a@example.com",
      name: "Ada",
      globalRole: "MEMBER",
      createdAt: now,
      updatedAt: now,
    };
    expect(() => userSchema.parse(user)).not.toThrow();
  });

  it("membershipSchema accepts a membership", () => {
    const m: Membership = {
      projectId: "proj_1",
      userId: "user_1",
      role: "EDITOR",
      createdAt: now,
    };
    expect(() => membershipSchema.parse(m)).not.toThrow();
  });

  it("apiKeyCreatedSchema accepts the one-time create result", () => {
    expect(() =>
      apiKeyCreatedSchema.parse({
        id: "key_1",
        name: "ci",
        prefix: "op_live_ab12",
        readOnly: true,
        secret: "op_live_ab12cd34...",
      }),
    ).not.toThrow();
  });

  it("qaConfigSchema accepts a QA config", () => {
    const config: QaConfig = {
      projectId: "proj_1",
      checks: { icu: { enabled: true, severity: "error" } },
      ignore: [{ checkId: "length", locale: "fr" }],
      updatedBy: "user_1",
      updatedAt: now,
    };
    expect(() => qaConfigSchema.parse(config)).not.toThrow();
  });

  it("qaReportSchema accepts a QA run report", () => {
    const finding = {
      checkId: "icu",
      severity: "error" as const,
      namespace: "default",
      keyName: "greeting",
      localeCode: "fr",
      message: "Mismatched placeholder",
      value: "Bonjour {nom}",
    };
    const report: QaReport = {
      projectId: "proj_1",
      baseLocale: "en",
      locales: ["fr"],
      checks: ["icu"],
      counts: { error: 1, warning: 0, info: 0 },
      findings: [finding],
      byLocale: { fr: [finding] },
    };
    expect(() => qaReportSchema.parse(report)).not.toThrow();
  });
});

describe("public schemas strip secrets", () => {
  it("apiKeyPublicSchema drops the secret hash", () => {
    const key: ApiKey = {
      id: "key_1",
      orgId: "org_1",
      userId: "user_1",
      name: "ci",
      hash: "deadbeef",
      prefix: "op_live_ab12",
      createdAt: now,
    };
    const parsed = apiKeyPublicSchema.parse(key);
    expect(parsed).not.toHaveProperty("hash");
    expect(parsed.prefix).toBe("op_live_ab12");
  });

  it("webhookPublicSchema drops the signing secret", () => {
    const hook: Webhook = {
      projectId: "proj_1",
      id: "wh_1",
      url: "https://example.com/hook",
      events: ["*"],
      secret: "shhh",
      createdAt: now,
    };
    const parsed = webhookPublicSchema.parse(hook);
    expect(parsed).not.toHaveProperty("secret");
    expect(parsed.url).toBe("https://example.com/hook");
  });
});

describe("error envelope", () => {
  it("accepts the shape every transport returns on error", () => {
    expect(() =>
      errorEnvelopeSchema.parse({ error: "Project not found", code: "NOT_FOUND", requestId: "r1" }),
    ).not.toThrow();
  });

  it("rejects an unknown error code", () => {
    expect(errorEnvelopeSchema.safeParse({ error: "x", code: "BOOM", requestId: "r1" }).success).toBe(
      false,
    );
  });
});
