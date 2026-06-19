import { describe, expect, it } from "vitest";
import { loadEnv } from "./helpers/env.js";
import { uniq } from "./helpers/fixtures.js";
import { makeMcpClient } from "./helpers/mcp.js";
import { makeRestClient } from "./helpers/rest.js";

/**
 * P1 — API-key lifecycle across the auth boundary. An admin mints a key for a
 * teammate; the key authenticates at BOTH deployed Function URLs; after
 * revocation the same key is rejected at both. Exercises the real
 * authenticate() path through the deployed Lambdas.
 */
const env = loadEnv();
const e = env ?? { mcpUrl: "", apiUrl: "", tableName: "", apiKey: "" };

describe.skipIf(!env)("P1 API-key lifecycle (MCP + REST)", () => {
  const ownerMcp = makeMcpClient(e.mcpUrl, e.apiKey);

  it("mints a working key, then revokes it and rejects it everywhere", async () => {
    const user = await ownerMcp<{ id: string }>("create_user", {
      email: `${uniq("teammate")}@turjuman.test`,
      name: "Teammate",
    });

    const key = await ownerMcp<{ id: string; secret: string }>("create_api_key", {
      name: uniq("ci-token"),
      userId: user.id,
    });
    expect(key.secret).toBeTruthy();

    // The freshly minted key authenticates at the MCP Function URL...
    const teammateMcp = makeMcpClient(e.mcpUrl, key.secret);
    await expect(teammateMcp("list_projects")).resolves.toBeDefined();

    // ...and at the REST Function URL.
    const teammateRest = makeRestClient(e.apiUrl, key.secret);
    const before = await teammateRest("GET", "v1/projects");
    expect(before.status).toBe(200);

    // Revoke it.
    await ownerMcp("revoke_api_key", { apiKeyId: key.id, userId: user.id });

    // Now rejected at both URLs.
    await expect(teammateMcp("list_projects")).rejects.toThrow(/401/);
    const after = await teammateRest("GET", "v1/projects");
    expect(after.status).toBe(401);
  });

  it("rejects a missing or garbage key at the REST boundary", async () => {
    const rest = makeRestClient(e.apiUrl);
    const noKey = await rest("GET", "v1/projects", { apiKey: null });
    expect(noKey.status).toBe(401);
    const garbage = await rest("GET", "v1/projects", { apiKey: "whsec_not-a-real-key" });
    expect(garbage.status).toBe(401);
  });
});
