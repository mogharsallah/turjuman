import { describe, expect, it } from "vitest";
import { loadEnv, modeOf } from "./helpers/env.js";
import { uniq } from "./helpers/fixtures.js";
import { makeOpClient } from "./helpers/mcp.js";
import { makeRestClient } from "./helpers/rest.js";

/**
 * P1 — the developer/CI persona, driven through the REST transport: the
 * deterministic push/pull path a CI job uses (import keys + translations, then
 * export them back). Also proves the MCP and REST surfaces share one table and
 * config — data written through one is visible through the other.
 */
const env = loadEnv();
const mode = modeOf(env);
const e = env ?? { mcpUrl: "", apiUrl: "", tableName: "", apiKey: "" };

interface Key {
	name: string;
}
interface Cell {
	locale: string;
	value: string;
}
interface BundleEntry {
	key: string;
	value: string;
}

describe.skipIf(mode !== "inprocess")("P1 developer CI sync (REST)", () => {
	const mcp = makeOpClient(e.mcpUrl, e.apiKey);
	const rest = makeRestClient(e.apiUrl, e.apiKey);

	it("imports keys + translations and exports them back over the Function URL", async () => {
		// Project creation is MCP-only; everything else here is the REST CI path.
		const project = await mcp<{ id: string }>("create_project", {
			name: uniq("CI Sync"),
			baseLocale: "en",
		});

		const locale = await rest("POST", `v1/projects/${project.id}/locales`, {
			body: { code: "fr" },
		});
		expect(locale.status).toBe(201);

		// CI push: seed source keys.
		const keysImport = await rest<{ created: number }>(
			"POST",
			`v1/projects/${project.id}/keys/import`,
			{
				body: {
					entries: [
						{
							name: "nav.home",
							description: "Top nav home link",
							baseValue: "Home",
						},
						{
							name: "nav.about",
							description: "Top nav about link",
							baseValue: "About",
						},
					],
				},
			},
		);
		expect(keysImport.status).toBe(200);
		expect(keysImport.json.created).toBe(2);

		// CI push: upload translations for a locale. Imported values land as drafts
		// (proposed), so the round-trip below pulls the working slot to read them back.
		const trImport = await rest<{ written: number }>(
			"POST",
			`v1/projects/${project.id}/translations/import`,
			{
				body: {
					locale: "fr",
					entries: [
						{ name: "nav.home", value: "Accueil" },
						{ name: "nav.about", value: "À propos" },
					],
				},
			},
		);
		expect(trImport.status).toBe(200);
		expect(trImport.json.written).toBe(2);

		// CI pull: the locale's cells carry the pushed values.
		const translations = await rest<{ locale: string; translations: Cell[] }>(
			"GET",
			`v1/projects/${project.id}/translations?locale=fr`,
		);
		expect(translations.status).toBe(200);
		expect(translations.json.translations.map((t) => t.value).sort()).toEqual(
			["Accueil", "À propos"].sort(),
		);

		// CI pull: the export bundle (working slot ships drafts) delivers them by name.
		const bundle = await rest<{ locale: string; entries: BundleEntry[] }>(
			"GET",
			`v1/projects/${project.id}/bundle?locale=fr&slot=working`,
		);
		expect(bundle.status).toBe(200);
		expect(
			Object.fromEntries(bundle.json.entries.map((b) => [b.key, b.value])),
		).toMatchObject({
			"nav.home": "Accueil",
			"nav.about": "À propos",
		});
	});

	it("keeps MCP and REST consistent: write via MCP, read via REST and back", async () => {
		const project = await mcp<{ id: string }>("create_project", {
			name: uniq("Cross Surface"),
			baseLocale: "en",
		});

		// Written via MCP...
		await mcp("create_key", {
			projectId: project.id,
			name: "feature.flag",
			description: "Created through MCP",
		});

		// ...visible via REST.
		const viaRest = await rest<{ keys: Key[] }>(
			"GET",
			`v1/projects/${project.id}/keys`,
		);
		expect(viaRest.status).toBe(200);
		expect(viaRest.json.keys.map((k) => k.name)).toContain("feature.flag");

		// Written via REST...
		await rest("POST", `v1/projects/${project.id}/keys/import`, {
			body: { entries: [{ name: "feature.beta", baseValue: "Beta" }] },
		});

		// ...visible via MCP.
		const viaMcp = await mcp<Key[]>("list_keys", { projectId: project.id });
		expect(viaMcp.map((k) => k.name)).toEqual(
			expect.arrayContaining(["feature.flag", "feature.beta"]),
		);

		// The same project is listed through both surfaces.
		const restProjects = await rest<{ projects: { id: string }[] }>(
			"GET",
			"v1/projects",
		);
		expect(restProjects.json.projects.map((p) => p.id)).toContain(project.id);
		const mcpProjects = await mcp<{ id: string }[]>("list_projects");
		expect(mcpProjects.map((p) => p.id)).toContain(project.id);
	});
});
