import { describe, expect, it } from "vitest";
import { loadEnv } from "./helpers/env.js";
import { uniq } from "./helpers/fixtures.js";
import { makeMcpClient, mcpListTools } from "./helpers/mcp.js";

/**
 * P1 — MCP tool-surface scoping, confirmed through the deployed path (the layer
 * unit tests can't: the real read-only-key actor and the Function URL's
 * query-string parsing). Both layers only narrow what `tools/list` advertises;
 * RBAC still authorizes every call.
 *  - Per-key: a read-only key sees only read tools.
 *  - Per-URL: `?groups=` narrows further; an unknown group fails loud with 400.
 */
const env = loadEnv();
const e = env ?? { mcpUrl: "", apiUrl: "", tableName: "", apiKey: "" };

describe.skipIf(!env)("P1 MCP tool scoping (deployed)", () => {
  const ownerMcp = makeMcpClient(e.mcpUrl, e.apiKey);

  it("advertises only read tools to a read-only key", async () => {
    const user = await ownerMcp<{ id: string }>("create_user", {
      email: `${uniq("ro")}@turjuman.test`,
      name: "Read-only user",
    });
    const key = await ownerMcp<{ secret: string }>("create_api_key", {
      name: uniq("ro-token"),
      userId: user.id,
      readOnly: true,
    });

    const tools = await mcpListTools(e.mcpUrl, key.secret);
    expect(tools).toContain("list_keys");
    expect(tools).not.toContain("delete_key");
    expect(tools).not.toContain("set_translation");
  });

  it("narrows tools/list via the ?groups= URL and 400s on an unknown group", async () => {
    const scoped = await mcpListTools(`${e.mcpUrl}?groups=read`, e.apiKey);
    expect(scoped).toContain("list_keys");
    expect(scoped).not.toContain("delete_key");

    // An unknown group fails loud (not a silent empty toolset).
    const res = await fetch(`${e.mcpUrl}?groups=bogus`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${e.apiKey}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(400);
  });
});
