import { createHash, randomBytes } from "node:crypto";
import type { Actor, ApiKey, User } from "@turjuman/schema";
import { conflict, newId, requireEmail, requireText } from "@turjuman/schema";
import type { RepositoryApi } from "./repository/index.js";

/**
 * Authentication & API-key secrets.
 *
 * Authentication (resolving an API key to an actor) is intentionally separate
 * from authorization (rbac.ts) and from the service layer. Secrets are returned
 * to the caller ONCE and never stored; only a sha256 hash and a short display
 * prefix are persisted.
 */

/**
 * Mint a new API key secret. The full secret is returned ONCE to the caller and
 * never stored; only its sha256 hash and a short display prefix are persisted.
 */
export function newApiKeySecret(): {
	secret: string;
	prefix: string;
	hash: string;
} {
	const secret = `op_live_${randomBytes(24).toString("base64url")}`;
	return { secret, prefix: secret.slice(0, 12), hash: hashApiKey(secret) };
}

/** Hash an API key secret for storage and lookup. */
export function hashApiKey(secret: string): string {
	return createHash("sha256").update(secret).digest("hex");
}

/** A successfully authenticated request. */
export interface AuthResult {
	actor: Actor;
	user: User;
	/** The API key's public id — safe to log (never the secret or its hash). */
	keyId: string;
	/**
	 * The best-effort "last used" stamp, already in flight with a `.catch` guard
	 * so it can never reject unhandled. It's kicked off here (not awaited) so it
	 * adds no latency, but on a runtime that freezes the event loop after the
	 * response (Lambda) the caller should `await` it before returning so the write
	 * isn't lost. Ignoring it preserves the previous fire-and-forget behaviour.
	 */
	touch: Promise<void>;
}

/** Resolve an authenticated actor and user from an API key secret. */
export async function authenticate(
	repo: RepositoryApi,
	secret: string | undefined,
): Promise<AuthResult | undefined> {
	if (!secret) return undefined;
	const apiKey = await repo.getApiKeyByHash(hashApiKey(secret));
	if (!apiKey) return undefined;
	// An expired key is treated exactly like an unknown one (no auth → 401).
	if (apiKey.expiresAt && Date.parse(apiKey.expiresAt) <= Date.now())
		return undefined;
	const user = await repo.getUser(apiKey.userId);
	if (!user) return undefined;
	const touch = repo.touchApiKey(apiKey.hash).catch(() => {
		// Best-effort last-used stamp; a failed write must never fail or reject auth.
	});
	return {
		user,
		keyId: apiKey.id,
		touch,
		actor: {
			userId: user.id,
			orgId: user.orgId,
			globalRole: user.globalRole,
			readOnly: apiKey.readOnly === true,
		},
	};
}

/**
 * Bootstrap the first OWNER for an organisation and mint their initial API key.
 * Intended for operator-run setup (not actor-gated).
 *
 * Guards against accidental re-use as a backdoor: if the org already has any
 * users it refuses unless `force: true` is passed. Also refuses a duplicate
 * email regardless.
 */
export async function bootstrapOwner(
	repo: RepositoryApi,
	input: { email: string; name: string; orgId?: string; force?: boolean },
): Promise<{ user: User; secret: string }> {
	const orgId = input.orgId ?? "default";
	// Friendly fast-path messages for the common (non-concurrent) cases. These are
	// advisory only — the authoritative single-owner guard is the atomic write
	// below, which closes the check-then-act race on the public bootstrap route.
	if (!input.force && (await repo.listUsersByOrg(orgId)).length > 0) {
		throw conflict(
			`Org "${orgId}" already has users; refusing to bootstrap another owner. Pass force=true to override.`,
		);
	}
	if (await repo.getUserByEmail(input.email)) {
		throw conflict(`A user with email ${input.email} already exists`);
	}
	const now = new Date().toISOString();
	const user: User = {
		id: newId("user"),
		orgId,
		email: requireEmail(input.email),
		name: requireText(input.name, "name"),
		globalRole: "OWNER",
		createdAt: now,
		updatedAt: now,
	};
	const { secret, prefix, hash } = newApiKeySecret();
	const apiKey: ApiKey = {
		id: newId("key"),
		orgId,
		userId: user.id,
		name: "bootstrap",
		hash,
		prefix,
		createdAt: now,
	};
	if (input.force) {
		// Operator override (never reachable over HTTP): force intentionally allows a
		// second owner, so it must bypass the single-owner sentinel. Non-atomic is
		// fine here — a credentialed operator, not a concurrent public caller.
		await repo.createUser(user);
		await repo.createApiKey(apiKey);
	} else {
		// One transaction: user + email companion + org-owner sentinel + key. The
		// sentinel's attribute_not_exists makes "one owner per org" race-safe, so two
		// concurrent POST /v1/bootstrap calls can never both create an OWNER.
		await repo.createOwnerWithKey(user, apiKey);
	}
	return { user, secret };
}
