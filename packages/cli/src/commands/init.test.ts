import { describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../config.js";
import { runInit } from "./init.js";
import { capturingSink } from "./fakes.test-helper.js";

describe("runInit", () => {
  it("builds a single-target config and emits the result", () => {
    const cap = capturingSink();
    const save = vi.fn((_c: ProjectConfig) => "/repo/turjuman.config.json");

    const result = runInit(
      { project: "proj_1", format: "json-flat", path: "i18n/{locale}.json", namespace: "web" },
      cap.sink,
      save,
    );

    const config: ProjectConfig = {
      projectId: "proj_1",
      targets: [{ format: "json-flat", path: "i18n/{locale}.json", namespace: "web" }],
    };
    expect(save).toHaveBeenCalledWith(config);
    expect(result).toEqual({ command: "init", file: "/repo/turjuman.config.json", config });
    expect(cap.result()).toEqual(result);
    expect(cap.lines).toEqual(["Wrote /repo/turjuman.config.json"]);
  });

  it("applies the documented defaults", () => {
    const cap = capturingSink();
    const save = vi.fn(() => "/repo/turjuman.config.json");

    runInit(
      { project: "proj_2", format: "json-nested", path: "locales/{locale}.json", namespace: "default" },
      cap.sink,
      save,
    );

    expect(save).toHaveBeenCalledWith({
      projectId: "proj_2",
      targets: [{ format: "json-nested", path: "locales/{locale}.json", namespace: "default" }],
    });
  });

  it("rejects an unknown format without writing", () => {
    const cap = capturingSink();
    const save = vi.fn(() => "/repo/turjuman.config.json");

    expect(() =>
      runInit({ project: "proj_3", format: "not-a-format", path: "x/{locale}.json" }, cap.sink, save),
    ).toThrowError();
    expect(save).not.toHaveBeenCalled();
  });
});
