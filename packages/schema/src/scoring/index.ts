/**
 * `@turjuman/schema/scoring` — the pure AI-scoring methodology layer.
 *
 * The MQM rubric, the prompt renderers, and the strict result contract. No AWS,
 * no I/O: `core/services/scoring.ts` loads the data and calls these, the single
 * seam between the methodology and the data model (mirrors `qa/` ↔ `services/qa.ts`).
 */
export * from "./types.js";
export * from "./rubric.js";
export * from "./prompt.js";
