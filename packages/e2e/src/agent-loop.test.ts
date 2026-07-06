import { describe, expect, it } from "vitest";
import { loadEnv, modeOf } from "./helpers/env.js";
import { uniq } from "./helpers/fixtures.js";
import { makeOpClient } from "./helpers/mcp.js";

/**
 * P1 — the core LLM/agent workflow, driven through the MCP transport. Proves the
 * operations an agent uses to fill and accept translations work through the real
 * code-mode surface (run_code → sandbox → bridge) + core + DynamoDB, not just the
 * unit-tested service logic.
 */
const env = loadEnv();
const mode = modeOf(env);
const e = env ?? { mcpUrl: "", apiUrl: "", tableName: "", apiKey: "" };

interface Cell {
	locale: string;
	value: string;
	lifecycle: string;
	head?: number;
}
interface KeyMeta {
	name: string;
}
interface UntranslatedList {
	locale: string;
	count: number;
	keys: KeyMeta[];
}

describe.skipIf(mode !== "inprocess")("P1 agent translation loop (MCP)", () => {
	const mcp = makeOpClient(e.mcpUrl, e.apiKey);

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
		expect(untranslated.keys.map((k) => k.name).sort()).toEqual([
			"checkout.pay",
			"checkout.title",
		]);

		// It translates the batch and proposes it in one call.
		const result = await mcp<{ written: number; skipped: string[] }>(
			"bulk_set_translations",
			{
				projectId: project.id,
				locale: "fr",
				entries: [
					{ name: "checkout.title", value: "Paiement" },
					{ name: "checkout.pay", value: "Payer maintenant" },
				],
			},
		);
		expect(result.written).toBe(2);
		expect(result.skipped).toEqual([]);

		// fr now has values (so it drops out of untranslated); es is untouched.
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

		// Reading the key back confirms the stored value; a bulk write lands proposed.
		const cells = await mcp<Cell[]>("get_translations", {
			projectId: project.id,
			name: "checkout.title",
		});
		const fr = cells.find((c) => c.locale === "fr");
		expect(fr).toMatchObject({ value: "Paiement", lifecycle: "proposed" });
	});

	it("supports the review workflow: propose then accept into the version chain", async () => {
		const project = await mcp<{ id: string }>("create_project", {
			name: uniq("Review Flow"),
			baseLocale: "en",
		});
		await mcp("add_locale", { projectId: project.id, code: "de" });
		await mcp("create_key", {
			projectId: project.id,
			name: "greeting",
			description: "Home screen greeting",
			baseValue: "Hello",
		});

		// Propose a value — it lands as `proposed`.
		await mcp("set_translation", {
			projectId: project.id,
			locale: "de",
			name: "greeting",
			value: "Hallo",
		});
		let cells = await mcp<Cell[]>("get_translations", {
			projectId: project.id,
			name: "greeting",
		});
		expect(cells.find((c) => c.locale === "de")).toMatchObject({
			value: "Hallo",
			lifecycle: "proposed",
		});

		// Accept it — the controlled transition that advances the cell's head.
		const accepted = await mcp<Cell>("accept_translation", {
			projectId: project.id,
			locale: "de",
			name: "greeting",
		});
		expect(accepted).toMatchObject({ lifecycle: "accepted", head: 1 });

		cells = await mcp<Cell[]>("get_translations", {
			projectId: project.id,
			name: "greeting",
		});
		expect(cells.find((c) => c.locale === "de")).toMatchObject({
			value: "Hallo",
			lifecycle: "accepted",
		});
	});
});
