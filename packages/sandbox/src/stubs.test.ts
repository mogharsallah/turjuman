import { OPERATIONS } from "@turjuman/sdk";
import { describe, expect, it } from "vitest";
import { generateStubSource } from "./stubs.js";

describe("generateStubSource", () => {
  it("emits a turjuman client method for every operation", () => {
    const src = generateStubSource();
    for (const op of OPERATIONS) {
      expect(src).toContain(`${JSON.stringify(op.name)}: (args) => __c(`);
    }
    // Exposes console and freezes the surface; never deletes the global bridges
    // (deleting corrupts the QuickJS atom table under the engine).
    expect(src).toContain("globalThis.console");
    expect(src).toContain("Object.freeze");
    expect(src).not.toContain("delete globalThis");
  });

  it("can be restricted to a subset of operations", () => {
    const src = generateStubSource(OPERATIONS.filter((o) => o.name === "list_projects"));
    expect(src).toContain('"list_projects"');
    expect(src).not.toContain('"delete_project"');
  });
});
