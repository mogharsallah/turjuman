import { describe, expect, it } from "vitest";
import { loadEnv } from "./helpers/env.js";
import { uniq } from "./helpers/fixtures.js";
import { makeMcpClient } from "./helpers/mcp.js";
import { makeRestClient } from "./helpers/rest.js";

/**
 * P1 — the security boundary, confirmed through the deployed auth path (one
 * representative check per concern, not the exhaustive matrix Tier A owns):
 *  - RBAC: a VIEWER can read but not write; an EDITOR can write.
 *  - Tenant isolation: a key from another org cannot see this org's project.
 */
const env = loadEnv();
const e = env ?? {
	mcpUrl: "",
	apiUrl: "",
	tableName: "",
	apiKey: "",
	apiKeyOrgB: undefined as string | undefined,
};

/** Mint a project-scoped member with a fresh API key, returning its secret. */
async function makeMember(
	ownerMcp: ReturnType<typeof makeMcpClient>,
	projectId: string,
	role: "VIEWER" | "EDITOR",
): Promise<string> {
	const user = await ownerMcp<{ id: string }>("create_user", {
		email: `${uniq(role.toLowerCase())}@turjuman.test`,
		name: `${role} user`,
	});
	const key = await ownerMcp<{ secret: string }>("create_api_key", {
		name: uniq(`${role}-token`),
		userId: user.id,
	});
	await ownerMcp("add_member", { projectId, userId: user.id, role });
	return key.secret;
}

describe.skipIf(!env)("P1 security boundary", () => {
	const ownerMcp = makeMcpClient(e.mcpUrl, e.apiKey);

	it("enforces RBAC at the boundary: VIEWER reads, EDITOR writes", async () => {
		const project = await ownerMcp<{ id: string }>("create_project", {
			name: uniq("RBAC"),
			baseLocale: "en",
		});
		await ownerMcp("add_locale", { projectId: project.id, code: "fr" });
		await ownerMcp("create_key", {
			projectId: project.id,
			name: "title",
			description: "Page title",
		});

		const viewerKey = await makeMember(ownerMcp, project.id, "VIEWER");
		const editorKey = await makeMember(ownerMcp, project.id, "EDITOR");

		const viewerMcp = makeMcpClient(e.mcpUrl, viewerKey);
		const viewerRest = makeRestClient(e.apiUrl, viewerKey);
		const editorMcp = makeMcpClient(e.mcpUrl, editorKey);

		// VIEWER can read through both surfaces.
		await expect(
			viewerMcp("get_project", { projectId: project.id }),
		).resolves.toMatchObject({
			id: project.id,
		});
		const read = await viewerRest(
			"GET",
			`v1/projects/${project.id}/translations?locale=fr`,
		);
		expect(read.status).toBe(200);

		// VIEWER cannot write — denied at both surfaces.
		await expect(
			viewerMcp("set_translation", {
				projectId: project.id,
				locale: "fr",
				name: "title",
				value: "Titre",
			}),
		).rejects.toThrow();
		const viewerWrite = await viewerRest(
			"POST",
			`v1/projects/${project.id}/translations/import`,
			{
				body: { locale: "fr", entries: [{ name: "title", value: "Titre" }] },
			},
		);
		expect(viewerWrite.status).toBe(403);

		// EDITOR can write.
		await expect(
			editorMcp("set_translation", {
				projectId: project.id,
				locale: "fr",
				name: "title",
				value: "Titre",
			}),
		).resolves.toMatchObject({ value: "Titre" });
	});

	it.skipIf(!e.apiKeyOrgB)(
		"isolates tenants: another org cannot see this project",
		async () => {
			const project = await ownerMcp<{ id: string }>("create_project", {
				name: uniq("Tenant A"),
				baseLocale: "en",
			});

			const orgBMcp = makeMcpClient(e.mcpUrl, e.apiKeyOrgB as string);
			const orgBRest = makeRestClient(e.apiUrl, e.apiKeyOrgB as string);

			// Org B's own project list never contains org A's project.
			const list = await orgBMcp<{ id: string }[]>("list_projects");
			expect(list.map((p) => p.id)).not.toContain(project.id);

			// Direct reads are NOT_FOUND, not FORBIDDEN — the project is invisible.
			await expect(
				orgBMcp("get_project", { projectId: project.id }),
			).rejects.toThrow();
			const restGet = await orgBRest("GET", `v1/projects/${project.id}`);
			expect(restGet.status).toBe(404);
		},
	);
});
