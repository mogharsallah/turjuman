/**
 * `@turjuman/schema` — the pure, AWS-free core of Turjuman.
 *
 * This is the shared brain everything else builds on: the canonical domain model
 * (zod schemas + inferred types), input validation, the transport wire shapes,
 * the RBAC policy matrix, ICU plural helpers, and the QA check engine. It pulls
 * in no AWS SDK, so the developer CLI and any third-party tooling can depend on
 * it without the DynamoDB/server weight (that lives in `@turjuman/core`).
 */
export * from "./domain.js";
export * from "./errors.js";
export * from "./ids.js";
export * from "./rbac.js";
export * from "./transport.js";
export * from "./validation.js";
export * from "./wire.js";
export * from "./plural.js";
export * as qa from "./qa/index.js";
