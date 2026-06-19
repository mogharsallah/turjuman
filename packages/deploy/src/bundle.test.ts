import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { bundleFunction } from "./bundle.js";
import { DEPLOY_FUNCTIONS, findRepoRoot } from "./functions.js";

describe("bundleFunction", () => {
  it("bundles a function into a zip containing its handler file", async () => {
    const root = findRepoRoot();
    const mcp = DEPLOY_FUNCTIONS.find((f) => f.logicalId === "McpFunction")!;

    const artifact = await bundleFunction(root, mcp);

    expect(artifact.hash).toMatch(/^[0-9a-f]{16}$/);
    const entries = new AdmZip(artifact.zip).getEntries().map((e) => e.entryName);
    expect(entries).toContain("handler.js");
    const body = new AdmZip(artifact.zip).readAsText("handler.js");
    expect(body.length).toBeGreaterThan(0);
    // The createRequire banner from the function definition should be present.
    expect(body).toContain("createRequire");
  }, 30_000);

  it("produces a stable hash for identical source", async () => {
    const root = findRepoRoot();
    const mcp = DEPLOY_FUNCTIONS.find((f) => f.logicalId === "McpFunction")!;

    const a = await bundleFunction(root, mcp);
    const b = await bundleFunction(root, mcp);
    expect(a.hash).toBe(b.hash);
  }, 30_000);
});
