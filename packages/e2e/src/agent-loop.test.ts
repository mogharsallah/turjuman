import { describe, expect, it } from "vitest";
import { loadEnv } from "./helpers/env.js";
import { uniq } from "./helpers/fixtures.js";
import { makeMcpClient } from "./helpers/mcp.js";

/**
 * P1 — the core LLM/agent workflow, driven entirely through the deployed MCP
 * Function URL. Proves the tools an agent uses to
 * fill and review translations survive the deployment boundary, not just the
 * unit-tested service logic.
 */
const env = loadEnv();
const e = env ?? { mcpUrl: "", apiUrl: "", tableName: "", apiKey: "" };

interface Translation {
  localeCode: string;
  keyName: string;
  value: string;
  status: string;
}
interface KeyMeta {
  name: string;
}
interface UntranslatedList {
  locale: string;
  count: number;
  keys: KeyMeta[];
}

describe.skipIf(!env)("P1 agent translation loop (MCP)", () => {
  const mcp = makeMcpClient(e.mcpUrl, e.apiKey);

  it("creates a project, finds untranslated keys, bulk-fills, and confirms values", async () => {
    const project = await mcp<{ id: string }>("create_project", {
      name: uniq("Agent Loop"),
      baseLocale: "en",
    });
    expect(project.id).toMatch(/^proj_/);

    await mcp("add_locale", { projectId: project.id, code: "fr" });
    await mcp("add_locale", { projectId: project.id, code: "es" });

    await mcp("create_key", {
      projectId: project.id,
      name: "checkout.title",
      description: "Heading on the checkout page",
      baseValue: "Checkout",
    });
    await mcp("create_key", {
      projectId: project.id,
      name: "checkout.pay",
      description: "Label on the pay button",
      baseValue: "Pay now",
    });

    // The agent asks what still needs translating for fr — both keys do.
    // list_untranslated returns { locale, count, keys } so a client gets context too.
    const untranslated = await mcp<UntranslatedList>("list_untranslated", {
      projectId: project.id,
      locale: "fr",
    });
    expect(untranslated.keys.map((k) => k.name).sort()).toEqual(["checkout.pay", "checkout.title"]);

    // It translates the batch and writes it back in one call.
    const result = await mcp<{ written: number; skipped: string[] }>("bulk_set_translations", {
      projectId: project.id,
      locale: "fr",
      entries: [
        { name: "checkout.title", value: "Paiement" },
        { name: "checkout.pay", value: "Payer maintenant" },
      ],
    });
    expect(result.written).toBe(2);
    expect(result.skipped).toEqual([]);

    // fr is now fully translated; es is untouched.
    const stillFr = await mcp<UntranslatedList>("list_untranslated", {
      projectId: project.id,
      locale: "fr",
    });
    expect(stillFr.keys).toHaveLength(0);
    const stillEs = await mcp<UntranslatedList>("list_untranslated", {
      projectId: project.id,
      locale: "es",
    });
    expect(stillEs.keys).toHaveLength(2);

    // Reading the key back confirms the stored value + translated status.
    const translations = await mcp<Translation[]>("get_translations", {
      projectId: project.id,
      name: "checkout.title",
    });
    const fr = translations.find((t) => t.localeCode === "fr");
    expect(fr).toMatchObject({ value: "Paiement", status: "translated" });
  });

  it("supports the review workflow: translate then mark approved", async () => {
    const project = await mcp<{ id: string }>("create_project", {
      name: uniq("Review Flow"),
      baseLocale: "en",
    });
    await mcp("add_locale", { projectId: project.id, code: "de" });
    await mcp("create_key", {
      projectId: project.id,
      name: "greeting",
      description: "Home screen greeting",
    });

    await mcp("set_translation", {
      projectId: project.id,
      locale: "de",
      name: "greeting",
      value: "Hallo",
    });

    let translations = await mcp<Translation[]>("get_translations", {
      projectId: project.id,
      name: "greeting",
    });
    expect(translations.find((t) => t.localeCode === "de")).toMatchObject({
      value: "Hallo",
      status: "translated",
    });

    await mcp("set_translation_status", {
      projectId: project.id,
      locale: "de",
      name: "greeting",
      status: "approved",
    });

    translations = await mcp<Translation[]>("get_translations", {
      projectId: project.id,
      name: "greeting",
    });
    expect(translations.find((t) => t.localeCode === "de")).toMatchObject({
      value: "Hallo",
      status: "approved",
      approvedValue: "Hallo",
    });
  });
});
