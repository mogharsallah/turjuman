import {
	type Actor,
	hashApiKey,
	type Repository,
	type TurjumanService,
	type User,
} from "@turjuman/core";
import { createApp, type RouterDeps } from "./router.js";

/**
 * Shared hermetic scaffolding for the REST router suites (`router-authz`,
 * `router-projection`, `router`). Lives in a `*.test-support.ts` file so the
 * package build (`tsconfig.json` `exclude`) keeps it out of the published `dist`,
 * and so vitest doesn't try to run it as a spec.
 *
 * NOTE on the `as unknown as Repository` below: TESTING.md's "no cast — the fake
 * must `implements RepositoryApi`" rule targets the *data-layer* fake (core's
 * `FakeRepo`). That fake can't be reused here: core excludes its `src/testing/**`
 * from its own published `dist`, so it isn't importable across the package
 * boundary. The router only calls `repo` to authenticate, so these suites use a
 * deliberately minimal *auth-only* stub (three methods) instead — the cast is
 * confined to this one helper rather than copied into each spec.
 */

export const SECRET = "test-secret";

/** The single authenticated caller these suites resolve the bearer key to. */
export const AUTH_USER: Actor = {
	userId: "user_1",
	orgId: "default",
	globalRole: "OWNER",
};

/** Bearer header for a GET; `jsonHeaders` adds the JSON content-type for writes. */
export const auth = { headers: { authorization: `Bearer ${SECRET}` } };
export const jsonHeaders = {
	...auth.headers,
	"content-type": "application/json",
};

/** A repo that authenticates exactly one bearer secret and nothing else — only the
 * methods `authenticate()` touches. Not the data-layer fake (see file header). */
export function fakeRepo(): Repository {
	return {
		getApiKeyByHash: async (hash: string) =>
			hash === hashApiKey(SECRET)
				? {
						id: "key_1",
						orgId: "default",
						userId: AUTH_USER.userId,
						name: "t",
						hash,
						prefix: "op_live_t",
						createdAt: "now",
					}
				: undefined,
		getUser: async (id: string) =>
			id === AUTH_USER.userId
				? ({
						...AUTH_USER,
						id: AUTH_USER.userId,
						email: "t@t.com",
						name: "T",
						createdAt: "now",
						updatedAt: "now",
					} as User)
				: undefined,
		touchApiKey: async () => {},
	} as unknown as Repository;
}

/** Build an app whose service sub-objects are the given stubs/spy. */
export function appWith(service: unknown) {
	return createApp({
		repo: fakeRepo(),
		service: service as TurjumanService,
	} as RouterDeps);
}

/**
 * A call-recording stand-in for `TurjumanService`: every `service.<sub>.<method>`
 * access resolves to a function that records `{ method, args }` and returns
 * `Promise.resolve(canned)`. Intentionally mirrors the sdk op-fixtures' spy — the
 * two can't share code across the published-`dist` boundary, but both are pure
 * recorders so the wiring assertion is identical.
 */
export function spyService(canned: unknown): {
	service: TurjumanService;
	calls: { method: string; args: unknown[] }[];
} {
	const calls: { method: string; args: unknown[] }[] = [];
	const service = new Proxy(
		{},
		{
			get(_t, sub) {
				if (typeof sub !== "string") return undefined;
				return new Proxy(
					{},
					{
						get(_t2, method) {
							if (typeof method !== "string") return undefined;
							return (...args: unknown[]) => {
								calls.push({ method: `${sub}.${method}`, args });
								return Promise.resolve(canned);
							};
						},
					},
				);
			},
		},
	) as unknown as TurjumanService;
	return { service, calls };
}
