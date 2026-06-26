import variant from "@jitl/quickjs-singlefile-mjs-release-sync";
import fc from "fast-check";
import {
  type QuickJSContext,
  type QuickJSRuntime,
  type QuickJSWASMModule,
  newQuickJSWASMModuleFromVariant,
} from "quickjs-emscripten-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { errorHandle, hostToHandle } from "./marshal.js";

/**
 * Layer 2 — the host↔guest marshalling edges (TESTING.md, closes Gap 3 precisely).
 * `engine.test.ts` already covers the bridge end-to-end (routing, masking,
 * isolation, byte/UAF/multibyte traps) and stays verbatim as a regression trap;
 * this file pins the value-marshalling edges that path exercises only indirectly:
 *   - `hostToHandle` evalCodes `(${JSON.stringify(v)})`, so a string that mimics
 *     code must come back as DATA, never execute (the security crux of marshalling);
 *   - JSON coercions (`undefined`→guest undefined, `undefined`-in-array→null,
 *     NaN/Infinity→null, dropped undefined props);
 *   - the BigInt edge at `marshal.ts:12` (`JSON.stringify(bigint)` throws);
 *   - deep nesting.
 *
 * The independent oracle for the happy path is `JSON.parse(JSON.stringify(v))` — a
 * SECOND deserializer of the same JSON string, so agreement proves the evalCode
 * path parses JSON exactly like the platform (no coercion, no injection).
 */
const SEED = 0x5a_11d0;

let mod: QuickJSWASMModule;
let runtime: QuickJSRuntime;
let ctx: QuickJSContext;

beforeAll(async () => {
  mod = await newQuickJSWASMModuleFromVariant(variant);
  runtime = mod.newRuntime();
  ctx = runtime.newContext();
});

afterAll(() => {
  ctx.dispose();
  runtime.dispose();
});

/** Marshal `value` into the guest, dump it back to a host value, dispose the handle. */
function marshalDump(value: unknown): unknown {
  const handle = hostToHandle(ctx, value);
  try {
    return ctx.dump(handle);
  } finally {
    // `hostToHandle` returns the shared `ctx.undefined` constant for the undefined
    // case — that singleton must not be disposed; every other handle is fresh.
    if (handle !== ctx.undefined) handle.dispose();
  }
}

/** Read back the `.message` of a guest Error built by `errorHandle`. */
function errorMessage(message: string): string {
  const handle = errorHandle(ctx, message);
  try {
    const msg = ctx.getProp(handle, "message");
    try {
      return ctx.getString(msg);
    } finally {
      msg.dispose();
    }
  } finally {
    handle.dispose();
  }
}

/** Evaluate guest `code` and dump the result to a host value. */
function evalDump(code: string): unknown {
  const handle = ctx.unwrapResult(ctx.evalCode(code));
  try {
    return ctx.dump(handle);
  } finally {
    handle.dispose();
  }
}

/** The central happy-path oracle: marshalling agrees with JSON round-tripping. */
function expectJsonIdentical(value: unknown): void {
  expect(marshalDump(value)).toEqual(JSON.parse(JSON.stringify(value)));
}

describe("hostToHandle — no code injection (the marshalling security crux)", () => {
  it("treats a string that mimics a wrapper break-out as data, never code", () => {
    // The marshaller wraps the JSON in `(...)` and evalCodes it. A string crafted
    // to break out of that wrapper must round-trip verbatim and run nothing.
    const attack = `")); globalThis.__pwned = 1; ((("`;
    expect(marshalDump(attack)).toBe(attack);
    expect(evalDump(`typeof __pwned`)).toBe("undefined");
  });

  it("round-trips strings with backslashes, quotes, parens and newlines", () => {
    for (const s of [")", "\\", "\\\\", `"`, `a)\\b"c`, "line1\nline2\tend", "}]);//", "${x}`"]) {
      expect(marshalDump(s)).toBe(s);
    }
  });
});

describe("hostToHandle — JSON coercions", () => {
  it("maps top-level undefined to guest undefined", () => {
    expect(marshalDump(undefined)).toBeUndefined();
  });

  it("maps a non-JSON-serializable value (function, symbol) to guest undefined", () => {
    expect(marshalDump(() => 1)).toBeUndefined();
    expect(marshalDump(Symbol("s"))).toBeUndefined();
  });

  it("coerces undefined array elements to null (JSON semantics)", () => {
    expect(marshalDump([1, undefined, 2])).toEqual([1, null, 2]);
    expectJsonIdentical([1, undefined, 2]);
  });

  it("drops undefined-valued object properties (JSON semantics)", () => {
    expect(marshalDump({ a: 1, b: undefined })).toEqual({ a: 1 });
    expectJsonIdentical({ a: 1, b: undefined, c: () => 1 });
  });

  it("coerces NaN/Infinity to null (JSON semantics)", () => {
    expect(marshalDump({ x: NaN, y: Infinity, z: -Infinity })).toEqual({ x: null, y: null, z: null });
  });
});

describe("hostToHandle — the BigInt edge (marshal.ts:12)", () => {
  it("throws on a top-level BigInt — JSON.stringify cannot serialize it", () => {
    // Documents the boundary: operation results are JSON-serializable by contract;
    // a BigInt (not JSON) surfaces here as a synchronous throw, not silent loss.
    expect(() => marshalDump(1n)).toThrow(TypeError);
  });

  it("throws on a BigInt nested in an object", () => {
    expect(() => marshalDump({ big: 1n })).toThrow();
  });
});

describe("hostToHandle — deep nesting", () => {
  it("round-trips a deeply nested mixed structure", () => {
    // Linear nesting only — referencing `v` more than once per level would make
    // it a DAG that JSON.stringify expands into an exponential tree.
    let v: unknown = "leaf";
    for (let i = 0; i < 50; i++) v = { child: v, idx: i };
    expectJsonIdentical(v);
  });
});

describe("errorHandle", () => {
  it("builds a guest Error carrying the message verbatim", () => {
    expect(errorMessage("NOT_FOUND: no such project")).toBe("NOT_FOUND: no such project");
  });

  it("preserves quotes/backslashes and allows no message injection", () => {
    const msg = `"); globalThis.__pwned_err = 1; new Error("`;
    expect(errorMessage(msg)).toBe(msg);
    expect(evalDump(`typeof __pwned_err`)).toBe("undefined");
  });

  it("produces a real guest Error (instanceof Error, readable .message)", () => {
    const handle = errorHandle(ctx, "boom");
    try {
      ctx.setProp(ctx.global, "__e", handle);
    } finally {
      handle.dispose();
    }
    expect(evalDump(`__e instanceof Error && __e.message === "boom"`)).toBe(true);
  });
});

describe("hostToHandle — JSON-value round-trip (property)", () => {
  it("matches JSON.parse∘JSON.stringify for every generated JSON value", () => {
    // Independent oracle: a second deserializer of the same JSON string. The
    // evalCode path must agree with the platform parser for ALL JSON values.
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        expect(marshalDump(v)).toEqual(JSON.parse(JSON.stringify(v)));
      }),
      { seed: SEED, numRuns: 300 },
    );
  });
});
