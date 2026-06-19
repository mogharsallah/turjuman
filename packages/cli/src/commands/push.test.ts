import { describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../config.js";
import { runPush } from "./push.js";
import { capturingSink, fakeApi } from "./fakes.test-helper.js";

const config: ProjectConfig = {
  projectId: "proj_1",
  targets: [{ format: "json-flat", path: "locales/{locale}.json", namespace: "default" }],
};

const locales = { locales: [{ code: "en" }, { code: "fr" }] };
const project = { baseLocale: "en" };

function reader(files: Record<string, string>) {
  return (path: string): string | undefined => files[path];
}

describe("runPush", () => {
  it("imports keys from the base-locale file and translations from others", async () => {
    const importKeys = vi.fn(async () => ({
      created: 2,
      updated: 1,
      reactivated: 0,
      baseValuesSet: 3,
      deleted: 0,
      deprecated: 0,
    }));
    const importTranslations = vi.fn(async () => ({ written: 2, skipped: [] as string[] }));
    const api = fakeApi({
      getProject: async () => project as never,
      listLocales: async () => locales as never,
      importKeys,
      importTranslations,
    });
    const cap = capturingSink();
    const files = reader({
      "locales/en.json": JSON.stringify({ a: "A", b: "B" }),
      "locales/fr.json": JSON.stringify({ a: "Ah", b: "Beh" }),
    });

    const { result } = await runPush(api, config, {}, cap.sink, files);

    expect(importKeys).toHaveBeenCalledWith(
      "proj_1",
      [
        { name: "a", baseValue: "A", description: undefined, plural: false },
        { name: "b", baseValue: "B", description: undefined, plural: false },
      ],
      "default",
      { prune: undefined, deprecate: true },
    );
    expect(importTranslations).toHaveBeenCalledWith("proj_1", "fr", [
      { name: "a", namespace: "default", value: "Ah" },
      { name: "b", namespace: "default", value: "Beh" },
    ]);
    expect(result.files).toHaveLength(2);
    expect(result.files[0]).toMatchObject({ path: "locales/en.json", kind: "keys", created: 2 });
    expect(result.files[1]).toMatchObject({ path: "locales/fr.json", kind: "translations", written: 2 });
  });

  it("hard-deletes with --prune (deprecate=false)", async () => {
    const importKeys = vi.fn(async () => ({
      created: 0,
      updated: 0,
      reactivated: 0,
      baseValuesSet: 0,
      deleted: 1,
      deprecated: 0,
    }));
    const api = fakeApi({
      getProject: async () => project as never,
      listLocales: async () => ({ locales: [{ code: "en" }] }) as never,
      importKeys,
    });
    const cap = capturingSink();
    await runPush(api, config, { prune: true }, cap.sink, reader({ "locales/en.json": JSON.stringify({ a: "A" }) }));
    expect(importKeys).toHaveBeenCalledWith("proj_1", expect.anything(), "default", { prune: true, deprecate: false });
  });

  it("dry-run reports planned changes without importing", async () => {
    const importKeys = vi.fn();
    const listKeys = vi.fn(async () => ({ keys: [{ name: "a" }] }));
    const api = fakeApi({
      getProject: async () => project as never,
      listLocales: async () => ({ locales: [{ code: "en" }] }) as never,
      listKeys: listKeys as never,
      importKeys: importKeys as never,
    });
    const cap = capturingSink();
    const { result } = await runPush(
      api,
      config,
      { dryRun: true },
      cap.sink,
      reader({ "locales/en.json": JSON.stringify({ a: "A", b: "B" }) }),
    );
    expect(importKeys).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
    expect(result.files[0]).toMatchObject({ kind: "keys", planned: { created: 1, existing: 1 } });
  });

  it("runs QA checks with --check and returns the report", async () => {
    const report = {
      counts: { error: 1, warning: 0, info: 0 },
      findings: [{ localeCode: "fr", severity: "error", namespace: "default", keyName: "a", checkId: "icu", message: "bad" }],
    };
    const api = fakeApi({
      getProject: async () => project as never,
      listLocales: async () => ({ locales: [{ code: "en" }] }) as never,
      importKeys: async () =>
        ({ created: 0, updated: 0, reactivated: 0, baseValuesSet: 0, deleted: 0, deprecated: 0 }) as never,
      runChecks: async () => report as never,
    });
    const cap = capturingSink();
    const { report: got } = await runPush(
      api,
      config,
      { check: true },
      cap.sink,
      reader({ "locales/en.json": JSON.stringify({ a: "A" }) }),
    );
    expect(got?.counts.error).toBe(1);
    expect((cap.result() as { check?: unknown }).check).toMatchObject({ counts: { error: 1 } });
  });

  it("skips locales whose file is absent", async () => {
    const importKeys = vi.fn(async () => ({
      created: 0,
      updated: 0,
      reactivated: 0,
      baseValuesSet: 0,
      deleted: 0,
      deprecated: 0,
    }));
    const importTranslations = vi.fn();
    const api = fakeApi({
      getProject: async () => project as never,
      listLocales: async () => locales as never,
      importKeys,
      importTranslations: importTranslations as never,
    });
    const cap = capturingSink();
    await runPush(api, config, {}, cap.sink, reader({ "locales/en.json": JSON.stringify({ a: "A" }) }));
    expect(importTranslations).not.toHaveBeenCalled();
  });
});
