import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { OPERATIONS, OPERATIONS_BY_NAME } from "./operations/index.js";
import {
	makeCtx,
	OP_FIXTURES,
	type OpFixture,
	spyService,
} from "./testing/op-fixtures.js";

/**
 * Layer 0 — the handler arg-mapping contract (TESTING.md). The glue
 * `(args, ctx) => service.X(args.projectId, …)` in every operation had ~no direct
 * coverage; a swapped or dropped positional arg shipped green. This loops the
 * `OPERATIONS` registry for *structure* but asserts *behaviour* against the
 * hand-authored oracle in `./testing/op-fixtures.ts` — distinct per-field
 * sentinels, the exact expected service call(s), and (for re-wrapping handlers)
 * the synthesized return value. A missing fixture fails the loop (the ratchet).
 */

function variantsFor(name: string): OpFixture[] {
	const entry = OP_FIXTURES[name];
	if (!entry) return [];
	return Array.isArray(entry) ? entry : [entry];
}

describe("handler arg-mapping contract", () => {
	describe.each(OPERATIONS)("$name", (op) => {
		it("has a fixture", () => {
			expect(
				OP_FIXTURES[op.name],
				`no op-fixture for "${op.name}" — add one`,
			).toBeDefined();
		});

		const variants = variantsFor(op.name);
		const labelled = variants.map((v, i) => ({
			v,
			label: v.variant ?? `variant ${i}`,
		}));

		describe.each(labelled)("$label", ({ v }) => {
			it("fires exactly the expected service call(s)", async () => {
				const { service, calls } = spyService(v.returns);
				const ret = await op.handler(v.input, makeCtx(service));

				expect(calls.length, `${op.name}: wrong number of service calls`).toBe(
					v.calls.length,
				);
				// Exact methods, order, and every positional arg (incl. the ACTOR slot).
				expect(calls).toEqual(
					v.calls.map((c) => ({ method: c.method, args: c.args })),
				);

				if ("result" in v) {
					expect(ret).toEqual(v.result);
				}
			});
		});
	});

	// The one branch the loop can't model: get_translations throws when given
	// neither `name` nor `locale`, and must not touch the service.
	it("get_translations throws (no service call) when neither name nor locale is given", async () => {
		const op = OPERATIONS_BY_NAME.get("get_translations")!;
		const { service, calls } = spyService(undefined);
		// Wrapped in an async IIFE so a synchronous throw surfaces as a rejection.
		await expect(
			(async () =>
				op.handler({ projectId: "P_projectId" }, makeCtx(service)))(),
		).rejects.toThrow(/name.*locale|locale/i);
		expect(calls).toEqual([]);
	});
});

/**
 * Meta-tests — keep the fixtures honest, so "registry-complete" means "actually
 * asserted", not "present". They kill the failure modes the oracle is meant to
 * prevent: a stale fixture, a trivial sentinel, an unpopulated field.
 */
describe("op-fixture validity (meta)", () => {
	it("no fixture references an unknown operation", () => {
		for (const name of Object.keys(OP_FIXTURES)) {
			expect(
				OPERATIONS_BY_NAME.has(name),
				`fixture "${name}" is not a real operation`,
			).toBe(true);
		}
	});

	describe.each(OPERATIONS)("$name", (op) => {
		const variants = variantsFor(op.name);

		it("each variant validates against op.input AND is already normalized", () => {
			expect(variants.length, "expected at least one variant").toBeGreaterThan(
				0,
			);
			for (const v of variants) {
				// Parses (valid input) and round-trips unchanged — so the input we author
				// is exactly what a transport delivers post-validation, and the expected
				// args stay a clean hand-written oracle (no hidden zod transform).
				expect(op.input.parse(v.input)).toEqual(v.input);
			}
		});

		it("top-level string fields use distinct sentinels (catches positional swaps)", () => {
			for (const v of variants) {
				const strings = Object.values(v.input).filter(
					(x): x is string => typeof x === "string",
				);
				expect(
					new Set(strings).size,
					"duplicate string sentinel in one input",
				).toBe(strings.length);
			}
		});

		it("variants together populate every input field", () => {
			const shape = (op.input as z.ZodObject<z.ZodRawShape>).shape ?? {};
			const covered = new Set(variants.flatMap((v) => Object.keys(v.input)));
			for (const field of Object.keys(shape)) {
				expect(
					covered.has(field),
					`input field "${field}" is never populated by a fixture`,
				).toBe(true);
			}
		});

		it("every variant expects at least one service call", () => {
			for (const v of variants) {
				expect(
					v.calls.length,
					"a variant must assert at least one service call",
				).toBeGreaterThan(0);
			}
		});
	});
});
