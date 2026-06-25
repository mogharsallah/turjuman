import { OPERATIONS } from "@turjuman/sdk";

/**
 * Guest-side bootstrap source. It captures the host bridges (`__callOp`, `__log`)
 * and exposes the ergonomic capability surface: a frozen `turjuman` client whose
 * methods are `turjuman.<operation>(args)` (names identical to the MCP tools, so
 * `search_sdk` results map 1:1) and a `console` that routes to the host.
 *
 * The raw `__callOp`/`__log` globals are left in place on purpose. They ARE the
 * sandbox's only capability — `__callOp("x", args)` is exactly equivalent to
 * `turjuman.x(args)` — so hiding them buys no isolation (the guest can reach the
 * same broker either way; the authenticated context and token are never exposed
 * to guest code regardless). Deleting them is also unsafe: `delete globalThis.*`
 * corrupts the QuickJS atom table under asyncify. Isolation comes from QuickJS
 * giving the guest no network/fs/env/timers at all — not from name-hiding.
 *
 * Each stub body is just `__callOp("name", args)`; the host resolves the
 * operation and returns its result, so the guest can `await` it (the bridge is
 * asyncified — see the engine).
 */
export function generateStubSource(operations = OPERATIONS): string {
  const entries = operations
    .map((o) => `  ${JSON.stringify(o.name)}: (args) => __c(${JSON.stringify(o.name)}, args),`)
    .join("\n");
  return `(() => {
  const __c = globalThis.__callOp;
  const __l = globalThis.__log;
  globalThis.turjuman = Object.freeze({
${entries}
  });
  globalThis.console = Object.freeze({
    log: (...a) => __l("log", a),
    info: (...a) => __l("info", a),
    warn: (...a) => __l("warn", a),
    error: (...a) => __l("error", a),
    debug: (...a) => __l("debug", a),
  });
})();`;
}
