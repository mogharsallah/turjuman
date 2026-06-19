import { newApiKeySecret } from "../auth.js";
import type { ApiKey } from "@turjuman/schema";
import { notFound, validation } from "@turjuman/schema";
import { newId } from "@turjuman/schema";
import { type Actor, requireOrg } from "@turjuman/schema";
import { requireText } from "@turjuman/schema";
import { BaseService } from "./base.js";

export class ApiKeysService extends BaseService {
  /**
   * Issue an API key. A user may always mint a key for themselves; minting one
   * for another user requires org-level apikey.manage. Returns the secret ONCE.
   *
   * `expiresAt` (ISO-8601, must be in the future) sets an expiry after which the
   * key stops authenticating; `readOnly` restricts the key to read actions
   * regardless of the user's role (a least-privilege credential for CI/dashboards).
   */
  async create(
    actor: Actor,
    input: { name: string; userId?: string; expiresAt?: string; readOnly?: boolean },
  ): Promise<{ apiKey: ApiKey; secret: string }> {
    const targetUserId = input.userId ?? actor.userId;
    if (targetUserId !== actor.userId) requireOrg(actor, "apikey.manage");
    const target = await this.repo.getUser(targetUserId);
    if (!target || target.orgId !== actor.orgId) throw notFound("User not found");
    const { secret, prefix, hash } = newApiKeySecret();
    const apiKey: ApiKey = {
      id: newId("key"),
      orgId: actor.orgId,
      userId: targetUserId,
      name: requireText(input.name, "name"),
      hash,
      prefix,
      createdAt: new Date().toISOString(),
      expiresAt: parseExpiry(input.expiresAt),
      readOnly: input.readOnly === true ? true : undefined,
    };
    await this.repo.createApiKey(apiKey);
    return { apiKey, secret };
  }

  async list(actor: Actor, userId?: string): Promise<ApiKey[]> {
    const targetUserId = userId ?? actor.userId;
    if (targetUserId !== actor.userId) {
      requireOrg(actor, "apikey.manage");
      const target = await this.repo.getUser(targetUserId);
      if (!target || target.orgId !== actor.orgId) throw notFound("User not found");
    }
    return this.repo.listApiKeysByUser(targetUserId);
  }

  /**
   * Revoke (permanently delete) an API key by its id. A user may always revoke
   * their own keys; revoking another user's key requires org-level
   * apikey.manage. Returns the revoked id.
   */
  async revoke(
    actor: Actor,
    apiKeyId: string,
    userId?: string,
  ): Promise<{ revoked: string }> {
    const targetUserId = userId ?? actor.userId;
    if (targetUserId !== actor.userId) requireOrg(actor, "apikey.manage");
    const target = (await this.repo.listApiKeysByUser(targetUserId)).find((k) => k.id === apiKeyId);
    if (!target || target.orgId !== actor.orgId) throw notFound("API key not found");
    await this.repo.deleteApiKey(target.hash);
    return { revoked: apiKeyId };
  }
}

/** Validate an optional ISO-8601 expiry: it must parse and be in the future. */
function parseExpiry(expiresAt: string | undefined): string | undefined {
  if (expiresAt === undefined) return undefined;
  const ms = Date.parse(expiresAt);
  if (Number.isNaN(ms)) throw validation("expiresAt must be an ISO-8601 date-time");
  if (ms <= Date.now()) throw validation("expiresAt must be in the future");
  return new Date(ms).toISOString();
}
