import { forbidden, notFound } from "@turjuman/core";
import type { OpContext } from "@turjuman/sdk";
import { describe, expect, it, vi } from "vitest";
import { runCode } from "./index.js";

/** A fake authenticated context whose service methods are spies, so a test can
 * assert the bridge routed to the right operation handler with the right args. */
function fakeCtx(service: Record<string, unknown>): OpContext {
  return {
    service,
    actor: { userId: "u", orgId: "o", globalRole: "OWNER", readOnly: false },
    user: {},
    requestId: "req-test",
  } as unknown as OpContext;
}

describe("runCode — bridge routing", () => {
  it("routes turjuman.* calls to the matching op.handler with the actor", async () => {
    const list = vi.fn(async () => [{ id: "p1" }, { id: "p2" }]);
    const get = vi.fn(async () => ({ id: "p1", name: "Demo" }));
    const ctx = fakeCtx({ projects: { list, get } });

    const res = await runCode({
      ctx,
      code: `
        const projects = await turjuman.list_projects({});
        const first = await turjuman.get_project({ projectId: projects[0].id });
        return { count: projects.length, name: first.name };
      `,
    });

    expect(res.ok).toBe(true);
    expect(res.result).toEqual({ count: 2, name: "Demo" });
    expect(res.opsUsed).toBe(2);
    // The handler received the request's actor, not anything from the guest.
    expect(list).toHaveBeenCalledWith(ctx.actor);
    expect(get).toHaveBeenCalledWith(ctx.actor, "p1");
  });

  it("validates op input at the bridge (bad args never reach the service)", async () => {
    const get = vi.fn();
    const res = await runCode({
      ctx: fakeCtx({ projects: { get } }),
      // get_project requires projectId; omit it.
      code: `return await turjuman.get_project({});`,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("VALIDATION");
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects an unknown operation", async () => {
    const res = await runCode({
      ctx: fakeCtx({}),
      code: `return await turjuman.not_a_real_op({});`,
    });
    expect(res.ok).toBe(false);
    // turjuman.not_a_real_op is undefined → calling it is a guest TypeError.
    expect(res.error).toMatch(/not a function|not_a_real_op/);
  });
});

describe("runCode — error masking at the boundary", () => {
  it("surfaces an AppError's code + message to the guest", async () => {
    const get = vi.fn(async () => {
      throw notFound("no such project");
    });
    const res = await runCode({
      ctx: fakeCtx({ projects: { get } }),
      code: `
        try { await turjuman.get_project({ projectId: "p1" }); }
        catch (e) { return { caught: e.message }; }
      `,
    });
    expect(res.ok).toBe(true);
    expect((res.result as { caught: string }).caught).toContain("NOT_FOUND: no such project");
  });

  it("masks a non-AppError fault behind the correlation id", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const get = vi.fn(async () => {
      throw new Error("DynamoDB exploded");
    });
    const res = await runCode({
      ctx: fakeCtx({ projects: { get } }),
      code: `try { await turjuman.get_project({ projectId: "p1" }); } catch (e) { return e.message; }`,
    });
    expect(res.ok).toBe(true);
    expect(res.result).toContain("Internal error (ref: req-test)");
    // The raw fault never reaches the guest...
    expect(res.result).not.toContain("DynamoDB exploded");
    // ...but it is logged server-side.
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("still routes forbidden (RBAC) as an AppError", async () => {
    const list = vi.fn(async () => {
      throw forbidden("nope");
    });
    const res = await runCode({
      ctx: fakeCtx({ members: { list } }),
      code: `try { await turjuman.list_members({ projectId: "p1" }); } catch (e) { return e.message; }`,
    });
    expect(res.result).toContain("FORBIDDEN: nope");
  });
});

describe("runCode — isolation (the security crux)", () => {
  it("exposes no ambient capabilities to the guest", async () => {
    const res = await runCode({
      ctx: fakeCtx({}),
      code: `
        return {
          fetch: typeof fetch,
          process: typeof process,
          require: typeof require,
          XMLHttpRequest: typeof XMLHttpRequest,
          setTimeout: typeof setTimeout,
          setInterval: typeof setInterval,
          WebAssembly: typeof WebAssembly,
        };
      `,
    });
    expect(res.ok).toBe(true);
    expect(res.result).toEqual({
      fetch: "undefined",
      process: "undefined",
      require: "undefined",
      XMLHttpRequest: "undefined",
      setTimeout: "undefined",
      setInterval: "undefined",
      WebAssembly: "undefined",
    });
  });

  it("never exposes the host context, service, or token to the guest", async () => {
    const res = await runCode({
      ctx: fakeCtx({ projects: { list: vi.fn(async () => []) } }),
      code: `
        return {
          ctx: typeof ctx,
          service: typeof service,
          dispatch: typeof dispatch,
          actor: typeof actor,
          turjuman: typeof turjuman,
          // None of the host closure's bindings are reachable as guest globals.
          hostGlobals: Object.getOwnPropertyNames(globalThis).filter(
            (k) => ["ctx", "service", "dispatch", "actor", "user", "requestId"].includes(k)
          ),
        };
      `,
    });
    expect(res.ok).toBe(true);
    expect(res.result).toMatchObject({
      ctx: "undefined",
      service: "undefined",
      dispatch: "undefined",
      actor: "undefined",
      turjuman: "object",
      hostGlobals: [],
    });
  });

  it("stops an infinite loop at the time cap", async () => {
    const res = await runCode({
      ctx: fakeCtx({}),
      code: `while (true) {}`,
      limits: { timeoutMs: 120 },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Execution timed out");
  });

  it("truncates oversized output", async () => {
    const res = await runCode({
      ctx: fakeCtx({}),
      code: `return "x".repeat(100000);`,
      limits: { maxOutputBytes: 1024 },
    });
    expect(res.ok).toBe(true);
    expect(res.truncated).toBe(true);
    expect(typeof res.result).toBe("string");
    expect((res.result as string)).toContain("output truncated");
  });

  it("truncates by BYTES (not code units) and never exceeds the cap or splits a char", async () => {
    const cap = 256;
    const res = await runCode({
      ctx: fakeCtx({}),
      // Multibyte content: each 😀 is 4 UTF-8 bytes but 2 UTF-16 code units.
      code: `return "😀".repeat(5000);`,
      limits: { maxOutputBytes: cap },
    });
    expect(res.ok).toBe(true);
    expect(res.truncated).toBe(true);
    const out = res.result as string;
    // The returned payload must fit the byte budget (a code-unit slice would blow it).
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(cap);
    // No lone replacement char from a split surrogate/multibyte sequence.
    expect(out).not.toContain("�");
  });

  it("bounds total console.* log bytes (logs can't blow the output budget)", async () => {
    const res = await runCode({
      ctx: fakeCtx({}),
      code: `for (let i = 0; i < 200; i++) console.log("😀".repeat(2000)); return "ok";`,
      limits: { maxLogBytes: 4096 },
    });
    expect(res.ok).toBe(true);
    const total = res.logs.reduce((n, l) => n + Buffer.byteLength(l.message, "utf8"), 0);
    expect(total).toBeLessThanOrEqual(4096);
    // No multibyte char was split when clamping an entry to the remaining budget.
    for (const l of res.logs) expect(l.message).not.toContain("�");
  });

  it("does not crash or use-after-free when a bridge call is not awaited", async () => {
    const rejections: unknown[] = [];
    const onRej = (r: unknown) => rejections.push(r);
    process.on("unhandledRejection", onRej);
    try {
      let ranAfter = false;
      const list = vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 40));
        ranAfter = true;
        return [{ id: "p1" }];
      });
      const res = await runCode({
        ctx: fakeCtx({ projects: { list } }),
        // Fire-and-forget: dispatch a slow op, then return before it settles.
        code: `turjuman.list_projects({}); return "returned-early";`,
      });
      expect(res.ok).toBe(true);
      expect(res.result).toBe("returned-early");
      // The run drains the in-flight dispatch before disposing the context, so the
      // op completed and nothing touched a freed runtime.
      expect(ranAfter).toBe(true);
      await new Promise((r) => setTimeout(r, 60));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRej);
    }
  });

  it("enforces the bridge-call budget", async () => {
    const list = vi.fn(async () => []);
    const res = await runCode({
      ctx: fakeCtx({ projects: { list } }),
      code: `for (let i = 0; i < 100; i++) { await turjuman.list_projects({}); } return "done";`,
      limits: { maxOps: 5 },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("operation budget");
    expect(list.mock.calls.length).toBeLessThanOrEqual(5);
  });
});

describe("runCode — console capture", () => {
  it("captures console.* output as structured logs", async () => {
    const res = await runCode({
      ctx: fakeCtx({}),
      code: `console.log("hello", 42); console.warn("careful"); return "ok";`,
    });
    expect(res.ok).toBe(true);
    expect(res.logs).toEqual([
      { level: "log", message: "hello 42" },
      { level: "warn", message: "careful" },
    ]);
  });
});
