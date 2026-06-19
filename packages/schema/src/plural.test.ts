import { describe, expect, it } from "vitest";
import { buildIcuPlural, isIcuPlural, parseIcuPlural } from "./plural.js";

describe("ICU plural", () => {
  it("detects plural messages", () => {
    expect(isIcuPlural("{n, plural, one {x} other {y}}")).toBe(true);
    expect(isIcuPlural("plain string")).toBe(false);
  });

  it("parses categories and var name", () => {
    const p = parseIcuPlural("{count, plural, one {# item} other {# items}}");
    expect(p).toEqual({ varName: "count", forms: { one: "# item", other: "# items" } });
  });

  it("ignores non-category selectors like =0", () => {
    const p = parseIcuPlural("{count, plural, =0 {none} one {# item} other {# items}}");
    expect(p?.forms).toEqual({ one: "# item", other: "# items" });
  });

  it("handles nested braces in messages", () => {
    const p = parseIcuPlural("{count, plural, one {{count} item} other {{count} items}}");
    expect(p?.forms).toEqual({ one: "{count} item", other: "{count} items" });
  });

  it("round-trips parse -> build in CLDR order", () => {
    const value = "{count, plural, one {# item} few {# items} other {# items}}";
    expect(buildIcuPlural(parseIcuPlural(value)!)).toBe(value);
  });

  it("returns null for non-plural input", () => {
    expect(parseIcuPlural("just text")).toBeNull();
  });
});
