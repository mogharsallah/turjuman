import type { Actor } from "@turjuman/core";
import { describe, expect, it } from "vitest";
import { allowedToolsForActor, resolveToolScope } from "./scope.js";

const actor = (over: Partial<Actor>): Actor => ({
  userId: "u",
  orgId: "default",
  globalRole: "OWNER",
  ...over,
});

/** Pure unit tests for URL tool-scope resolution. The wire-level effect (a
 * scoped tools/list and an out-of-scope tools/call) is covered in protocol.test.ts. */
describe("resolveToolScope", () => {
  it("returns undefined (no filter) when no scope params are given", () => {
    expect(resolveToolScope(undefined)).toBeUndefined();
    expect(resolveToolScope({})).toBeUndefined();
    expect(resolveToolScope({ other: "x" })).toBeUndefined();
    // Present-but-empty values are treated as no filter, never "zero tools".
    expect(resolveToolScope({ tools: "", groups: " , " })).toBeUndefined();
  });

  it("resolves an explicit tools allowlist", () => {
    const scope = resolveToolScope({ tools: "get_key, list_keys" });
    expect(scope).toEqual({ allowed: new Set(["get_key", "list_keys"]) });
  });

  it("expands a domain group", () => {
    const scope = resolveToolScope({ groups: "keys" });
    expect(scope && "allowed" in scope).toBe(true);
    const allowed = (scope as { allowed: Set<string> }).allowed;
    expect(allowed).toContain("list_keys");
    expect(allowed).toContain("delete_key");
    // delete_project is grouped under `projects`, not surfaced via `keys`.
    expect(allowed).not.toContain("delete_project");
  });

  it("groups delete_project under projects (decoupled from the source arrays)", () => {
    const allowed = (resolveToolScope({ groups: "projects" }) as { allowed: Set<string> }).allowed;
    expect(allowed).toContain("delete_project");
    expect(allowed).toContain("create_project");
  });

  it("resolves the synthetic read group to read-only tools only", () => {
    const allowed = (resolveToolScope({ groups: "read" }) as { allowed: Set<string> }).allowed;
    expect(allowed).toContain("list_keys");
    expect(allowed).toContain("get_key");
    expect(allowed).toContain("run_qa_checks");
    // No write/destructive tool leaks into the read surface.
    expect(allowed).not.toContain("delete_key");
    expect(allowed).not.toContain("set_translation");
    expect(allowed).not.toContain("create_project");
  });

  it("unions tools and groups", () => {
    const allowed = (resolveToolScope({ tools: "delete_key", groups: "qa" }) as { allowed: Set<string> })
      .allowed;
    expect(allowed).toContain("delete_key");
    expect(allowed).toContain("run_qa_checks");
  });

  it("fails loud on an unknown tool", () => {
    const scope = resolveToolScope({ tools: "get_key,nope_tool" });
    expect(scope).toMatchObject({ error: expect.stringContaining("nope_tool") });
  });

  it("fails loud on an unknown group and lists the valid groups", () => {
    const scope = resolveToolScope({ groups: "bogus" }) as { error: string };
    expect(scope.error).toContain("bogus");
    expect(scope.error).toContain("read");
    expect(scope.error).toContain("keys");
  });
});

describe("allowedToolsForActor", () => {
  it("shows an OWNER the full toolset", () => {
    expect(allowedToolsForActor(actor({ globalRole: "OWNER" })).size).toBe(45);
  });

  it("shows an ADMIN the full toolset (has project.create + user.manage)", () => {
    const allowed = allowedToolsForActor(actor({ globalRole: "ADMIN" }));
    expect(allowed.has("create_project")).toBe(true);
    expect(allowed.has("set_user_role")).toBe(true);
    expect(allowed.size).toBe(45);
  });

  it("hides only the org-gated tools a MEMBER can never reach", () => {
    const allowed = allowedToolsForActor(actor({ globalRole: "MEMBER" }));
    // MEMBER lacks project.create / user.manage:
    expect(allowed.has("create_project")).toBe(false);
    expect(allowed.has("create_user")).toBe(false);
    expect(allowed.has("set_user_role")).toBe(false);
    // ...but keeps tools reachable via project role or self-service, and reads:
    expect(allowed.has("list_users")).toBe(true); // user.read is global to MEMBER
    expect(allowed.has("add_member")).toBe(true); // project-gated (could be MANAGER)
    expect(allowed.has("create_api_key")).toBe(true); // self-service
    expect(allowed.has("set_translation")).toBe(true); // project-gated write
    expect(allowed.size).toBe(42);
  });

  it("restricts a read-only key to read tools regardless of role", () => {
    const allowed = allowedToolsForActor(actor({ globalRole: "OWNER", readOnly: true }));
    expect(allowed.has("list_keys")).toBe(true);
    expect(allowed.has("get_key")).toBe(true);
    expect(allowed.has("run_qa_checks")).toBe(true);
    expect(allowed.has("delete_key")).toBe(false);
    expect(allowed.has("set_translation")).toBe(false);
    expect(allowed.has("create_project")).toBe(false);
    // Every advertised tool is a read tool.
    expect([...allowed].every((n) => /^(list|get|search|lookup)_/.test(n) || n === "run_qa_checks")).toBe(
      true,
    );
  });
});
