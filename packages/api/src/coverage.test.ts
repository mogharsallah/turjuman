import { OPERATIONS, operationsMissingHttp } from "@turjuman/sdk";
import { describe, expect, it } from "vitest";
import { type RouterDeps, createApp } from "./router.js";

/**
 * Self-maintaining REST coverage tracker. The REST API is a projection of the
 * `@turjuman/sdk` operation registry; this enumerates the operations that do NOT
 * yet carry an `http` binding — the live "still missing vs MCP" list. It is
 * intentionally informational (the REST surface is deliberately a subset; see the
 * ADR) — but the second test is a real guard: every operation that DOES declare an
 * `http` binding must actually be served as a route, so a binding can't be added
 * without wiring the route (the gap the old hand-kept `migrated` list left open).
 */
describe("REST coverage vs the MCP/SDK operation registry", () => {
  it("reports the operations still missing an HTTP route", () => {
    const missing = operationsMissingHttp().sort();
    const covered = OPERATIONS.filter((o) => o.http).map((o) => o.name).sort();
    // Surface the gap in the test output so it's visible without grepping.
    // eslint-disable-next-line no-console
    console.info(
      `REST coverage: ${covered.length}/${OPERATIONS.length} operations projected; ` +
        `${missing.length} still MCP-only:\n  ${missing.join(", ")}`,
    );
    // covered/missing partition the registry: disjoint, and together exhaustive.
    expect(covered.filter((n) => missing.includes(n))).toEqual([]);
    expect([...covered, ...missing].sort()).toEqual(OPERATIONS.map((o) => o.name).sort());
  });

  it("serves a real route for every operation that declares an http binding", async () => {
    const res = await createApp({} as RouterDeps).request("/v1/openapi.json");
    const spec = (await res.json()) as { paths: Record<string, Record<string, unknown>> };

    const missingRoutes: string[] = [];
    for (const op of OPERATIONS) {
      if (!op.http) continue;
      // OpenAPI templates path params as `{name}`; the binding uses `:name`.
      const specPath = op.http.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
      if (!spec.paths[specPath]?.[op.http.method.toLowerCase()]) {
        missingRoutes.push(`${op.name} (${op.http.method.toUpperCase()} ${specPath})`);
      }
    }
    // An operation that declares an http binding but is never projected onto a
    // route would be a silent gap: reported "covered" by operationsMissingHttp()
    // yet unreachable over REST. Derived from the served spec, not a hand-kept list.
    expect(missingRoutes).toEqual([]);
  });
});
