import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  GROUP_BY_OPERATION,
  OPERATIONS,
  OPERATIONS_BY_NAME,
  OPERATION_GROUPS,
  effectiveAnnotations,
  isReadOnly,
  operationsMissingHttp,
  searchOperations,
  summarizeOperation,
} from "./index.js";

describe("operation registry", () => {
  it("declares a well-formed, uniquely-named operation set", () => {
    expect(OPERATIONS.length).toBeGreaterThan(0);
    const names = OPERATIONS.map((o) => o.name);
    expect(new Set(names).size).toBe(names.length); // no duplicate names
    for (const op of OPERATIONS) {
      expect(typeof op.name).toBe("string");
      expect(op.description.length).toBeGreaterThan(0);
      expect(op.input).toBeDefined();
      expect(typeof op.handler).toBe("function");
    }
  });

  it("keeps OPERATIONS_BY_NAME in lockstep with OPERATIONS", () => {
    expect(OPERATIONS_BY_NAME.size).toBe(OPERATIONS.length);
    for (const op of OPERATIONS) expect(OPERATIONS_BY_NAME.get(op.name)).toBe(op);
  });

  it("assigns every operation to exactly one group", () => {
    const grouped = Object.values(OPERATION_GROUPS).flat();
    // Every operation appears in a group, and no group references a stranger.
    expect(new Set(grouped.map((o) => o.name))).toEqual(new Set(OPERATIONS.map((o) => o.name)));
    for (const op of OPERATIONS) expect(GROUP_BY_OPERATION.get(op.name)).toBeDefined();
    // delete_project is presented under `projects`, not a "lifecycle" group.
    expect(GROUP_BY_OPERATION.get("delete_project")).toBe("projects");
  });
});

describe("effectiveAnnotations", () => {
  it("derives read-only / destructive / idempotent hints from the verb", () => {
    expect(effectiveAnnotations(OPERATIONS_BY_NAME.get("list_projects")!).readOnlyHint).toBe(true);
    expect(effectiveAnnotations(OPERATIONS_BY_NAME.get("delete_project")!).destructiveHint).toBe(true);
    expect(effectiveAnnotations(OPERATIONS_BY_NAME.get("revoke_api_key")!).destructiveHint).toBe(true);
    const setTranslation = effectiveAnnotations(OPERATIONS_BY_NAME.get("set_translation")!);
    expect(setTranslation.readOnlyHint).toBe(false);
    expect(setTranslation.idempotentHint).toBe(true);
    // An explicit annotation wins over the name-based derivation.
    expect(isReadOnly(OPERATIONS_BY_NAME.get("run_qa_checks")!)).toBe(true);
  });
});

describe("searchOperations", () => {
  it("ranks name matches first and returns summaries", () => {
    const results = searchOperations("translation");
    expect(results.length).toBeGreaterThan(0);
    const summary = summarizeOperation(OPERATIONS_BY_NAME.get("set_translation")!);
    expect(summary).toMatchObject({ name: "set_translation", group: "translations", readOnly: false });
    expect(summary.inputFields).toContain("projectId");
    // bulk_set_translations should surface for the query.
    expect(results.map((r) => r.name)).toContain("bulk_set_translations");
  });

  it("returns the whole registry (capped) for an empty query", () => {
    expect(searchOperations("", 1000)).toHaveLength(OPERATIONS.length);
  });
});

describe("coverage tracker", () => {
  it("lists operations without an http binding (the REST gap)", () => {
    // Phase 1: no http bindings yet, so every operation is reported missing.
    expect(operationsMissingHttp().sort()).toEqual(OPERATIONS.map((o) => o.name).sort());
  });
});

describe("transport agnosticism", () => {
  it("does not depend on @modelcontextprotocol/sdk", () => {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(all["@modelcontextprotocol/sdk"]).toBeUndefined();
  });
});
