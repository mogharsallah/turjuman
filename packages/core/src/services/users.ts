import type { GlobalRole, User } from "@turjuman/schema";
import { conflict, notFound } from "@turjuman/schema";
import { type Actor, requireOrg } from "@turjuman/schema";
import { BaseService } from "./base.js";

/** OWNER/ADMIN are privileged: granting or touching them needs `role.admin` (OWNER-only). */
const isPrivileged = (role: GlobalRole): boolean => role === "OWNER" || role === "ADMIN";

export class UsersService extends BaseService {
  async list(actor: Actor): Promise<User[]> {
    requireOrg(actor, "user.read");
    return this.repo.listUsersByOrg(actor.orgId);
  }

  async create(
    actor: Actor,
    input: { email: string; name: string; globalRole?: GlobalRole },
  ): Promise<User> {
    requireOrg(actor, "user.manage");
    // Minting an OWNER/ADMIN directly is itself a privileged grant.
    if (input.globalRole && isPrivileged(input.globalRole)) requireOrg(actor, "role.admin");
    return this.provisionUser(actor.orgId, input);
  }

  async setGlobalRole(actor: Actor, userId: string, role: GlobalRole): Promise<void> {
    requireOrg(actor, "user.manage");
    const user = await this.repo.getUser(userId);
    if (!user || user.orgId !== actor.orgId) throw notFound("User not found");
    // Changing the role of, or to, a privileged role is OWNER-only — this is
    // what makes OWNER strictly more powerful than ADMIN.
    if (isPrivileged(user.globalRole) || isPrivileged(role)) requireOrg(actor, "role.admin");
    // Never let the last OWNER be demoted, or the org becomes unadministerable.
    if (user.globalRole === "OWNER" && role !== "OWNER") {
      const owners = (await this.repo.listUsersByOrg(actor.orgId)).filter(
        (u) => u.globalRole === "OWNER",
      );
      if (owners.length <= 1) throw conflict("Cannot demote the last owner of the organization");
    }
    await this.repo.setUserGlobalRole(userId, role);
  }
}
