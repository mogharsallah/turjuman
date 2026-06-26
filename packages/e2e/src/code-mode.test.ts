import { describe, expect, it } from "vitest";
import { loadEnv } from "./helpers/env.js";
import { uniq } from "./helpers/fixtures.js";
import {
	makeCodeClient,
	makeMcpClient,
	mcpListTools,
	type SandboxRunResult,
} from "./helpers/mcp.js";

/**
 * P1 — code mode, confirmed through the deployed path (closes Gap 2: the entire
 * sandbox → bridge → core path over a real Function URL was proven only
 * hermetically). Covers:
 *  - `?mode=code` advertises exactly `search` + `describe` + `run_code` (and none
 *    of the classic tools) — mode selection over the Function URL.
 *  - `search` discovers operations over the deployed path.
 *  - `run_code` performs a write+read round-trip inside the sandbox.
 *  - the SAME translate-then-read journey, parametrized over classic AND code
 *    mode, yields the identical outcome (the two transports agree).
 */
const env = loadEnv();
const e = env ?? { mcpUrl: "", apiUrl: "", tableName: "", apiKey: "" };

interface Outcome {
	value: string;
	status: string;
}

describe.skipIf(!env)("P1 code mode (deployed)", () => {
	const code = makeCodeClient(e.mcpUrl, e.apiKey);

	it("advertises only search + describe + run_code in ?mode=code", async () => {
		const tools = await mcpListTools(`${e.mcpUrl}?mode=code`, e.apiKey);
		expect(tools.sort()).toEqual(["describe", "run_code", "search"]);
		// The classic per-operation tools are NOT advertised in code mode.
		expect(tools).not.toContain("create_project");
		expect(tools).not.toContain("set_translation");
	});

	it("discovers operations via search", async () => {
		// search returns results segmented by kind, with a true total; operations
		// carry a typed signature (title == the operation name / id stem).
		const res = await code.search<{
			total: number;
			operations: { title: string; signature?: string }[];
		}>("create project");
		expect(res.total).toBeGreaterThan(0);
		expect(res.operations.map((o) => o.title)).toContain("create_project");
	});

	it("runs a write+read round-trip inside the sandbox", async () => {
		const name = uniq("CodeMode");
		const res = await code.runCode<{ value: string; status: string }>(`
      const project = await turjuman.create_project({ name: ${JSON.stringify(name)}, baseLocale: "en" });
      await turjuman.add_locale({ projectId: project.id, code: "fr" });
      await turjuman.create_key({ projectId: project.id, name: "greeting", baseValue: "Hello" });
      await turjuman.set_translation({ projectId: project.id, locale: "fr", name: "greeting", value: "Bonjour" });
      const translations = await turjuman.get_translations({ projectId: project.id, name: "greeting" });
      const fr = translations.find((t) => t.localeCode === "fr");
      return { value: fr.value, status: fr.status };
    `);

		expect(res.error).toBeUndefined();
		expect(res.ok).toBe(true);
		expect(res.result).toEqual({ value: "Bonjour", status: "translated" });
		// Five bridge calls reached core through the sandbox.
		expect(res.opsUsed).toBe(5);
		expect(res.truncated).toBe(false);
	});

	it("masks a validation failure as a structured run result (not an MCP error)", async () => {
		// A bad op input is caught at the bridge: the run completes with ok:false, the
		// tool call itself does not error out.
		const res = await code.runCode(`return await turjuman.get_project({});`);
		expect(res.ok).toBe(false);
		expect(res.error).toContain("VALIDATION");
	});
});

// ── The same journey over both transports — they must agree ──
type Journey = (suffix: string) => Promise<Outcome>;

const MODES: { name: string; run: Journey }[] = [
	{
		name: "classic",
		run: async (suffix) => {
			const mcp = makeMcpClient(e.mcpUrl, e.apiKey);
			const project = await mcp<{ id: string }>("create_project", {
				name: suffix,
				baseLocale: "en",
			});
			await mcp("add_locale", { projectId: project.id, code: "fr" });
			await mcp("create_key", {
				projectId: project.id,
				name: "greeting",
				baseValue: "Hello",
			});
			await mcp("set_translation", {
				projectId: project.id,
				locale: "fr",
				name: "greeting",
				value: "Bonjour",
			});
			const translations = await mcp<
				{ localeCode: string; value: string; status: string }[]
			>("get_translations", {
				projectId: project.id,
				name: "greeting",
			});
			const fr = translations.find((t) => t.localeCode === "fr");
			return { value: fr!.value, status: fr!.status };
		},
	},
	{
		name: "code",
		run: async (suffix) => {
			const code = makeCodeClient(e.mcpUrl, e.apiKey);
			const res = await code.runCode<Outcome>(`
        const project = await turjuman.create_project({ name: ${JSON.stringify(suffix)}, baseLocale: "en" });
        await turjuman.add_locale({ projectId: project.id, code: "fr" });
        await turjuman.create_key({ projectId: project.id, name: "greeting", baseValue: "Hello" });
        await turjuman.set_translation({ projectId: project.id, locale: "fr", name: "greeting", value: "Bonjour" });
        const translations = await turjuman.get_translations({ projectId: project.id, name: "greeting" });
        const fr = translations.find((t) => t.localeCode === "fr");
        return { value: fr.value, status: fr.status };
      `);
			if (!res.ok) throw new Error(`run_code failed: ${res.error}`);
			return res.result as Outcome;
		},
	},
];

describe.skipIf(!env)(
	"P1 translate-then-read journey (classic vs code)",
	() => {
		describe.each(MODES)("$name mode", ({ run }) => {
			it("translates a key and reads back the stored value + status", async () => {
				const outcome = await run(uniq("Journey"));
				expect(outcome).toEqual({ value: "Bonjour", status: "translated" });
			});
		});
	},
);
