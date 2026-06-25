import { OPERATIONS, operationsMissingHttp } from "@turjuman/sdk";
import { describe, expect, it } from "vitest";

/**
 * Temporary, self-maintaining REST coverage tracker. The REST API is being grown
 * into a projection of the `@turjuman/sdk` operation registry; this enumerates the
 * operations that do NOT yet carry an `http` binding — the live "still missing vs
 * MCP" list. It is intentionally informational for now (the REST surface is
 * deliberately a subset; see the ADR). When full parity is intended, flip the
 * final assertion to require an empty gap.
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
    expect(covered.length + missing.length).toBe(OPERATIONS.length);
  });

  it("keeps the routes migrated to the projection covered (regression guard)", () => {
    const missing = new Set(operationsMissingHttp());
    const migrated = [
      "get_project",
      "add_locale",
      "run_qa_checks",
      "get_qa_config",
      "set_qa_config",
      "score_translation",
      "review_translations",
      "get_score_config",
      "set_score_config",
    ];
    for (const name of migrated) expect(missing.has(name)).toBe(false);
  });
});
