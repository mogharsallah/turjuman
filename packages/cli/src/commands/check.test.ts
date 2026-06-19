import { describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../config.js";
import { runCheck } from "./check.js";
import { capturingSink, fakeApi } from "./fakes.test-helper.js";

const config: ProjectConfig = { projectId: "proj_1", targets: [] };

describe("runCheck", () => {
  it("maps options to runChecks and emits a flat report payload", async () => {
    const runChecks = vi.fn(async () => ({
      counts: { error: 0, warning: 1, info: 0 },
      findings: [{ localeCode: "fr", severity: "warning", namespace: "default", keyName: "a", checkId: "length", message: "long" }],
    }));
    const api = fakeApi({ runChecks: runChecks as never });
    const cap = capturingSink();
    const report = await runCheck(api, config, { locale: "fr", checks: ["length"], approved: true }, cap.sink);

    expect(runChecks).toHaveBeenCalledWith("proj_1", { locale: "fr", checks: ["length"], slot: "approved" });
    expect(report.counts.warning).toBe(1);
    expect(cap.result()).toEqual({
      command: "check",
      counts: { error: 0, warning: 1, info: 0 },
      findings: report.findings,
    });
  });

  it("defaults slot to undefined (working) when --approved is absent", async () => {
    const runChecks = vi.fn(async () => ({ counts: { error: 0, warning: 0, info: 0 }, findings: [] }));
    const api = fakeApi({ runChecks: runChecks as never });
    await runCheck(api, config, {}, capturingSink().sink);
    expect(runChecks).toHaveBeenCalledWith("proj_1", { locale: undefined, checks: undefined, slot: undefined });
  });
});
