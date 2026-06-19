import type { Membership, ProjectRole } from "@turjuman/schema";
import { notFound } from "@turjuman/schema";
import { type Actor, canOnOrg } from "@turjuman/schema";
import { BaseService } from "./base.js";

export class MembersService extends BaseService {
  async list(actor: Actor, projectId: string): Promise<Membership[]> {
    await this.authorizeProject(actor, projectId, "member.read");
    return this.repo.listMembersByProject(projectId);
  }

  async add(
    actor: Actor,
    projectId: string,
    userRef: { userId?: string; email?: string; name?: string },
    role: ProjectRole,
  ): Promise<Membership> {
    await this.authorizeProject(actor, projectId, "member.manage");
    let user = await this.findUser(userRef);
    if (!user) {
      // A caller who can manage org users may add a brand-new teammate by email
      // in one step; the user is provisioned as a global MEMBER.
      if (userRef.email && canOnOrg(actor, "user.manage")) {
        user = await this.provisionUser(actor.orgId, {
          email: userRef.email,
          name: userRef.name ?? userRef.email.split("@")[0] ?? userRef.email,
        });
      } else if (userRef.email) {
        throw notFound(
          `No user with email ${userRef.email}. Create them first with create_user (requires admin), then add_member.`,
        );
      } else {
        throw notFound("User not found");
      }
    }
    if (user.orgId !== actor.orgId) throw notFound("User not found in this organization");
    const membership: Membership = {
      projectId,
      userId: user.id,
      role,
      createdAt: new Date().toISOString(),
    };
    return this.repo.putMembership(membership);
  }

  async setRole(
    actor: Actor,
    projectId: string,
    userId: string,
    role: ProjectRole,
  ): Promise<Membership> {
    await this.authorizeProject(actor, projectId, "member.manage");
    const existing = await this.repo.getMembership(projectId, userId);
    if (!existing) throw notFound("Membership not found");
    return this.repo.putMembership({ ...existing, role });
  }

  async remove(actor: Actor, projectId: string, userId: string): Promise<void> {
    await this.authorizeProject(actor, projectId, "member.manage");
    await this.repo.deleteMembership(projectId, userId);
  }
}
