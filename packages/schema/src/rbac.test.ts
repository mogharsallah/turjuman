import { describe, expect, it } from "vitest";
import { type Actor, canOnOrg, canOnProject, effectiveProjectRole } from "./rbac.js";

const member: Actor = { userId: "u1", orgId: "o1", globalRole: "MEMBER" };
const admin: Actor = { userId: "u2", orgId: "o1", globalRole: "ADMIN" };
const owner: Actor = { userId: "u3", orgId: "o1", globalRole: "OWNER" };

describe("effectiveProjectRole", () => {
  it("elevates OWNER/ADMIN to MANAGER on any project", () => {
    expect(effectiveProjectRole("OWNER", undefined)).toBe("MANAGER");
    expect(effectiveProjectRole("ADMIN", "VIEWER")).toBe("MANAGER");
  });

  it("uses the explicit membership role for a MEMBER", () => {
    expect(effectiveProjectRole("MEMBER", "EDITOR")).toBe("EDITOR");
    expect(effectiveProjectRole("MEMBER", undefined)).toBeUndefined();
  });
});

describe("canOnProject", () => {
  it("VIEWER can read but not write", () => {
    expect(canOnProject(member, "translation.read", "VIEWER")).toBe(true);
    expect(canOnProject(member, "translation.write", "VIEWER")).toBe(false);
    expect(canOnProject(member, "key.manage", "VIEWER")).toBe(false);
  });

  it("EDITOR can write and review translations but not manage members", () => {
    expect(canOnProject(member, "translation.write", "EDITOR")).toBe(true);
    expect(canOnProject(member, "translation.review", "EDITOR")).toBe(true);
    expect(canOnProject(member, "member.manage", "EDITOR")).toBe(false);
  });

  it("DEVELOPER can manage locales/keys and write but not review", () => {
    expect(canOnProject(member, "locale.manage", "DEVELOPER")).toBe(true);
    expect(canOnProject(member, "key.manage", "DEVELOPER")).toBe(true);
    expect(canOnProject(member, "translation.write", "DEVELOPER")).toBe(true);
    expect(canOnProject(member, "translation.review", "DEVELOPER")).toBe(false);
  });

  it("MANAGER can manage members", () => {
    expect(canOnProject(member, "member.manage", "MANAGER")).toBe(true);
  });

  it("everyone reads the glossary; VIEWER cannot manage it", () => {
    expect(canOnProject(member, "glossary.read", "VIEWER")).toBe(true);
    expect(canOnProject(member, "glossary.manage", "VIEWER")).toBe(false);
    expect(canOnProject(member, "glossary.manage", "EDITOR")).toBe(true);
    expect(canOnProject(member, "glossary.manage", "DEVELOPER")).toBe(true);
  });

  it("only MANAGER manages webhooks and deletes projects", () => {
    expect(canOnProject(member, "webhook.manage", "MANAGER")).toBe(true);
    expect(canOnProject(member, "webhook.manage", "EDITOR")).toBe(false);
    expect(canOnProject(member, "project.delete", "MANAGER")).toBe(true);
    expect(canOnProject(member, "project.delete", "DEVELOPER")).toBe(false);
  });

  it("a MEMBER with no membership can do nothing", () => {
    expect(canOnProject(member, "project.read", undefined)).toBe(false);
  });

  it("ADMIN can manage members regardless of membership", () => {
    expect(canOnProject(admin, "member.manage", undefined)).toBe(true);
  });
});

describe("canOnOrg", () => {
  it("only OWNER/ADMIN manage users and create projects", () => {
    expect(canOnOrg(admin, "user.manage")).toBe(true);
    expect(canOnOrg(admin, "project.create")).toBe(true);
    expect(canOnOrg(member, "user.manage")).toBe(false);
    expect(canOnOrg(member, "project.create")).toBe(false);
  });

  it("any member can read the user directory", () => {
    expect(canOnOrg(member, "user.read")).toBe(true);
  });

  it("only OWNER may manage privileged roles (role.admin)", () => {
    expect(canOnOrg(owner, "role.admin")).toBe(true);
    expect(canOnOrg(admin, "role.admin")).toBe(false);
    expect(canOnOrg(member, "role.admin")).toBe(false);
  });
});
