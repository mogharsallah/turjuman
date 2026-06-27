import type { ApiKey, Repository, TurjumanService, User } from "@turjuman/core";
import { describe, expect, it } from "vitest";
import { createApp, type RouterDeps } from "./router.js";

/**
 * The unauthenticated `POST /v1/bootstrap` first-owner route. Unlike the other
 * router suites (which use the auth-only stub), bootstrap exercises the data
 * layer, so this uses a small in-memory repo implementing exactly the four
 * methods `bootstrapOwner` touches, and asserts against that captured state (the
 * independent oracle) rather than trusting the HTTP echo.
 */
function memRepo(): { repo: Repository; users: User[]; apiKeys: ApiKey[] } {
	const users: User[] = [];
	const apiKeys: ApiKey[] = [];
	const repo = {
		listUsersByOrg: async (orgId: string) =>
			users.filter((u) => u.orgId === orgId),
		getUserByEmail: async (email: string) =>
			users.find((u) => u.email === email),
		// The route's (non-force) path goes through the atomic owner write.
		createOwnerWithKey: async (u: User, k: ApiKey) => {
			users.push(u);
			apiKeys.push(k);
		},
	} as unknown as Repository;
	return { repo, users, apiKeys };
}

function appFor(repo: Repository) {
	return createApp({ repo, service: {} as TurjumanService } as RouterDeps);
}

const post = (body: unknown) =>
	({
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	}) as const;

describe("POST /v1/bootstrap", () => {
	it("creates the first OWNER + key and returns the one-time secret (no auth)", async () => {
		const { repo, users, apiKeys } = memRepo();
		const res = await appFor(repo).request(
			"/v1/bootstrap",
			post({ email: "owner@example.com", name: "Owner" }),
		);

		expect(res.status).toBe(201);
		const json = (await res.json()) as { user: User; secret: string };
		expect(json.user).toMatchObject({
			email: "owner@example.com",
			name: "Owner",
			globalRole: "OWNER",
			orgId: "default",
		});
		expect(typeof json.secret).toBe("string");
		expect(json.secret.length).toBeGreaterThan(0);

		// Independent oracle: the owner + its key actually landed in the repo.
		expect(users).toHaveLength(1);
		expect(users[0]).toMatchObject({
			email: "owner@example.com",
			globalRole: "OWNER",
			orgId: "default",
		});
		expect(apiKeys).toHaveLength(1);
		expect(apiKeys[0]?.userId).toBe(users[0]?.id);
	});

	it("returns 409 once an owner exists and never creates a second", async () => {
		const { repo, users } = memRepo();
		const app = appFor(repo);
		const first = await app.request(
			"/v1/bootstrap",
			post({ email: "owner@example.com", name: "Owner" }),
		);
		expect(first.status).toBe(201);

		const second = await app.request(
			"/v1/bootstrap",
			post({ email: "other@example.com", name: "Other" }),
		);
		expect(second.status).toBe(409);
		expect(await second.json()).toMatchObject({ code: "CONFLICT" });
		expect(users).toHaveLength(1); // no second owner written
	});

	it("rejects a missing/invalid email with 400 VALIDATION", async () => {
		const { repo, users } = memRepo();
		const app = appFor(repo);

		const noEmail = await app.request("/v1/bootstrap", post({ name: "Owner" }));
		expect(noEmail.status).toBe(400);
		expect(await noEmail.json()).toMatchObject({ code: "VALIDATION" });

		const badEmail = await app.request(
			"/v1/bootstrap",
			post({ email: "not-an-email", name: "Owner" }),
		);
		expect(badEmail.status).toBe(400);
		expect(users).toHaveLength(0);
	});

	it("ignores orgId/force in the body — org is always 'default' and the guard holds", async () => {
		const { repo, users } = memRepo();
		const app = appFor(repo);

		// orgId is stripped by the schema: the owner lands in "default", not "evil".
		const first = await app.request(
			"/v1/bootstrap",
			post({ email: "owner@example.com", name: "Owner", orgId: "evil" }),
		);
		expect(first.status).toBe(201);
		expect(((await first.json()) as { user: User }).user.orgId).toBe("default");
		expect(users[0]?.orgId).toBe("default");

		// force is stripped too: a second call cannot bypass the single-owner guard.
		const second = await app.request(
			"/v1/bootstrap",
			post({ email: "other@example.com", name: "Other", force: true }),
		);
		expect(second.status).toBe(409);
		expect(users).toHaveLength(1);
	});
});
