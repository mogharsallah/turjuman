import { describe, expect, it } from "vitest";
import { type User } from "@turjuman/core";
import { OPERATIONS, OPERATIONS_BY_NAME, type OpContext } from "@turjuman/sdk";
import { AUTH_USER, appWith, auth, jsonHeaders, spyService } from "./transport.test-support.js";

/**
 * Layer 3 — REST-projection *wiring* (TESTING.md). `coverage.test.ts` already
 * guards that every `http`-bound operation is served at its bound method+path,
 * and `router-authz.test.ts` covers the error/authz/`op.input` re-validation
 * paths. This file pins the two remaining wiring invariants:
 *
 *  1. **Param landing** — the URL path/query params must reach the *correct*
 *     operation input field, and the JSON body must merge into the remaining
 *     slots. Asserted with a **distinct sentinel per field** so a `:id`→wrong-field
 *     or a body field swap can't pass. The expected `(method, args)` per route is
 *     hand-authored (the independent oracle), not derived from the handler.
 *  2. **Bespoke CLI routes** — the routes that deliberately bypass `OPERATIONS`
 *     (key/translation import, bundle export) carry behaviour the projection loop
 *     can't see: the wire→service field renames (`deprecate`→`deprecateAbsent`)
 *     and the intended `origin:"import"` vs `origin:"llm"` divergence. Pinned
 *     against golden envelopes so the divergence is a fixture, not a surprise.
 *
 * The repo/app/spy scaffolding is shared with the other router suites in
 * `./transport.test-support.ts`.
 */

const PID = "P_landing"; // the projectId sentinel, routed through the :id path param.

interface RestFixture {
  method: "get" | "post" | "put";
  /** Concrete URL with the PID sentinel substituted for the :id segment. */
  url: string;
  /** Hand-authored request body (write methods); distinct sentinel per field. */
  body?: Record<string, unknown>;
  /** The single service method the projection must call. */
  serviceMethod: string;
  /** Hand-authored check of the recorded positional args — the independent oracle. */
  check: (args: unknown[]) => void;
}

// One fixture per http-bound operation. PID always lands in slot 1; body fields
// land in their named slots with their own sentinels.
const REST_FIXTURES: Record<string, RestFixture> = {
  get_project: {
    method: "get",
    url: `/v1/projects/${PID}`,
    serviceMethod: "projects.get",
    check: (a) => expect(a[1]).toBe(PID),
  },
  add_locale: {
    method: "post",
    url: `/v1/projects/${PID}/locales`,
    body: { code: "zz", name: "L_localeName" },
    serviceMethod: "locales.add",
    check: (a) => {
      expect(a[1]).toBe(PID);
      expect(a[2]).toBe("zz"); // code → 3rd positional, not swapped with name
      expect(a[3]).toBe("L_localeName");
    },
  },
  run_qa_checks: {
    method: "post",
    url: `/v1/projects/${PID}/checks`,
    body: { locale: "zz", checks: ["icu"], slot: "working" },
    serviceMethod: "qa.run",
    check: (a) => {
      expect(a[1]).toBe(PID);
      // The wire field `checks` is renamed to the service field `checkIds`.
      expect(a[2]).toMatchObject({ locale: "zz", checkIds: ["icu"], slot: "working" });
    },
  },
  get_qa_config: {
    method: "get",
    url: `/v1/projects/${PID}/qa-config`,
    serviceMethod: "qa.getConfig",
    check: (a) => expect(a[1]).toBe(PID),
  },
  set_qa_config: {
    method: "put",
    url: `/v1/projects/${PID}/qa-config`,
    body: { checks: { icu: { enabled: false } } },
    serviceMethod: "qa.setConfig",
    check: (a) => {
      expect(a[1]).toBe(PID);
      expect(a[2]).toMatchObject({ checks: { icu: { enabled: false } } });
    },
  },
  score_translation: {
    method: "post",
    url: `/v1/projects/${PID}/translations/score`,
    body: { locale: "zz", name: "N_keyName", score: 42 },
    serviceMethod: "scoring.score",
    check: (a) => {
      expect(a[1]).toBe(PID);
      expect(a[2]).toBe("zz"); // locale → 3rd positional
      expect(a[3]).toMatchObject({ name: "N_keyName", score: 42 });
    },
  },
  review_translations: {
    method: "post",
    url: `/v1/projects/${PID}/translations/review`,
    body: { locale: "zz", entries: [{ name: "N_keyName", score: 42 }] },
    serviceMethod: "scoring.reviewBatch",
    check: (a) => {
      expect(a[1]).toBe(PID);
      expect(a[2]).toBe("zz");
      expect(a[3]).toMatchObject([{ name: "N_keyName", score: 42 }]);
    },
  },
  get_score_config: {
    method: "get",
    url: `/v1/projects/${PID}/score-config`,
    serviceMethod: "scoring.getConfig",
    check: (a) => expect(a[1]).toBe(PID),
  },
  set_score_config: {
    method: "put",
    url: `/v1/projects/${PID}/score-config`,
    body: { threshold: 77 },
    serviceMethod: "scoring.setConfig",
    check: (a) => {
      expect(a[1]).toBe(PID);
      expect(a[2]).toMatchObject({ threshold: 77 });
    },
  },
};

describe("REST projection — path/body params land on the correct input field", () => {
  // Drive the loop from the live registry so a newly http-bound operation without
  // a fixture fails here (the ratchet); assert behaviour against the hand-authored
  // fixture (the oracle).
  const httpOps = OPERATIONS.filter((o) => o.http).map((o) => o.name);

  it("has a wiring fixture for every http-bound operation", () => {
    const missing = httpOps.filter((n) => !REST_FIXTURES[n]);
    expect(missing).toEqual([]);
  });

  describe.each(httpOps.filter((n) => REST_FIXTURES[n]))("%s", (name) => {
    const fx = REST_FIXTURES[name]!;
    it(`routes ${fx.method.toUpperCase()} ${fx.url} → ${fx.serviceMethod} with params in the right slots`, async () => {
      const { service, calls } = spyService({ ok: true });
      const res = await appWith(service).request(fx.url, {
        method: fx.method.toUpperCase(),
        headers: jsonHeaders,
        ...(fx.body ? { body: JSON.stringify(fx.body) } : {}),
      });
      expect(res.status).toBeLessThan(300);
      // Exactly the one expected service method fired (no extra/auth calls).
      expect(calls).toHaveLength(1);
      expect(calls[0]!.method).toBe(fx.serviceMethod);
      // Slot 0 is the authenticated actor (from auth, not the URL); the rest are
      // checked by the fixture's hand-authored oracle.
      expect(calls[0]!.args[0]).toMatchObject({ userId: AUTH_USER.userId });
      fx.check(calls[0]!.args);
    });
  });
});

describe("Bespoke CLI routes — golden envelopes & the origin divergence", () => {
  it("CLI translation import stamps origin:\"import\" and returns the bulk-set envelope", async () => {
    const golden = { written: 2, skipped: ["default#ghost"] };
    const { service, calls } = spyService(golden);
    const res = await appWith(service).request(`/v1/projects/${PID}/translations/import`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        locale: "fr",
        entries: [
          { name: "a", value: "A" },
          { name: "b", value: "B", status: "approved" },
        ],
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(golden); // golden response envelope
    // The CLI push path marks every entry origin:"import" (a deterministic source
    // upload), distinct from the MCP set_translation path below.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("translations.bulkSet");
    expect(calls[0]!.args[1]).toBe(PID);
    expect(calls[0]!.args[2]).toBe("fr");
    expect(calls[0]!.args[3]).toEqual([
      { name: "a", value: "A", origin: "import" },
      { name: "b", value: "B", status: "approved", origin: "import" },
    ]);
  });

  it("the MCP set_translation handler stamps origin:\"llm\" — the other side of the divergence", () => {
    // set_translation has no REST route; exercise its operation handler directly so
    // the import-vs-llm origin split is pinned in one place, against both oracles.
    const op = OPERATIONS_BY_NAME.get("set_translation")!;
    const { service, calls } = spyService(undefined);
    const ctx: OpContext = {
      service,
      actor: AUTH_USER,
      user: { ...AUTH_USER, id: AUTH_USER.userId, email: "t@t.co", name: "T", createdAt: "now", updatedAt: "now" } as User,
      requestId: "req",
    };
    const input = op.input.parse({ projectId: PID, locale: "fr", name: "a", value: "A" });
    return Promise.resolve(op.handler(input, ctx)).then(() => {
      expect(calls).toHaveLength(1);
      expect(calls[0]!.method).toBe("translations.set");
      expect(calls[0]!.args[3]).toMatchObject({ name: "a", value: "A", origin: "llm" });
    });
  });

  it("CLI key import renames deprecate→deprecateAbsent and returns the import summary", async () => {
    const golden = { created: 1, updated: 0, reactivated: 0, baseValuesSet: 1, deleted: 0, deprecated: 2 };
    const { service, calls } = spyService(golden);
    const res = await appWith(service).request(`/v1/projects/${PID}/keys/import`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        entries: [{ name: "a", baseValue: "A" }],
        namespace: "ns",
        prune: false,
        deprecate: true,
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(golden);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("keys.import");
    // entries, namespace pass through positionally; the wire `deprecate` flag is
    // renamed to the service's `deprecateAbsent`.
    expect(calls[0]!.args[1]).toBe(PID);
    expect(calls[0]!.args[2]).toEqual([{ name: "a", baseValue: "A" }]);
    expect(calls[0]!.args[3]).toBe("ns");
    expect(calls[0]!.args[4]).toEqual({ prune: false, deprecateAbsent: true });
  });

  it("bundle export returns the {locale, entries} envelope (no nextCursor when unpaged)", async () => {
    const entries = [{ namespace: "default", key: "a", value: "A" }];
    const { service, calls } = spyService(entries);
    const res = await appWith(service).request(`/v1/projects/${PID}/bundle?locale=fr`, {
      headers: auth.headers,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ locale: "fr", entries }); // golden envelope
    expect(calls[0]!.method).toBe("translations.exportBundle");
    expect(calls[0]!.args[1]).toBe(PID);
    expect(calls[0]!.args[2]).toBe("fr");
  });
});
