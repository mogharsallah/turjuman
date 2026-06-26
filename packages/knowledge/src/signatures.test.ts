import { OPERATIONS, op, z } from "@turjuman/sdk";
import { describe, expect, it } from "vitest";
import {
	inputFields,
	operationHints,
	operationSignature,
	outputType,
} from "./signatures.js";

/**
 * Layer 1 — the zod-to-signature renderer as a pure projection (TESTING.md).
 *
 * Two independent oracles:
 *  1. A structure loop over the `OPERATIONS` registry — every operation renders a
 *     signature that starts with its name and lists exactly the fields of its zod
 *     input. The expectation derives from `op.input.shape` (the schema), NOT from
 *     the renderer, so it is a real check, not `X === X`. A new operation whose
 *     input the renderer can't introspect fails its named row (the ratchet).
 *  2. A hand-authored type table over SYNTHETIC operations — we author both the
 *     zod field and the exact string it must render to, fully independent of the
 *     renderer's internals.
 */

/** Build a throwaway operation around one input field. */
function probe(field: z.ZodTypeAny, output?: z.ZodTypeAny) {
	return op({
		name: "probe",
		description: "d",
		input: z.object({ f: field }),
		output,
		handler: async () => null,
	});
}

// Oracle 2: hand-authored (zod field) -> (rendered type, optional) rows.
const TYPE_ROWS: {
	label: string;
	field: z.ZodTypeAny;
	type: string;
	optional: boolean;
}[] = [
	{ label: "string", field: z.string(), type: "string", optional: false },
	{ label: "number", field: z.number(), type: "number", optional: false },
	{ label: "boolean", field: z.boolean(), type: "boolean", optional: false },
	{
		label: "enum",
		field: z.enum(["m", "n"]),
		type: '"m" | "n"',
		optional: false,
	},
	{
		label: "string array",
		field: z.array(z.string()),
		type: "string[]",
		optional: false,
	},
	{
		label: "optional string",
		field: z.string().optional(),
		type: "string",
		optional: true,
	},
	{
		label: "defaulted number",
		field: z.number().default(5),
		type: "number",
		optional: true,
	},
	{
		label: "nullable-then-optional",
		field: z.string().nullable().optional(),
		type: "string",
		optional: true,
	},
];

describe("renderer type table (independent oracle)", () => {
	describe.each(TYPE_ROWS)("$label", ({ field, type, optional }) => {
		it("renders the field type and optionality", () => {
			const [only] = inputFields(probe(field));
			expect(only).toMatchObject({ name: "f", type, optional });
		});
	});

	it("renders a full multi-field signature in field order", () => {
		const p = op({
			name: "make_thing",
			description: "d",
			input: z.object({
				a: z.string(),
				b: z.number().optional(),
				c: z.enum(["x", "y"]),
				d: z.array(z.string()),
			}),
			handler: async () => null,
		});
		expect(operationSignature(p)).toBe(
			'make_thing(a: string, b?: number, c: "x" | "y", d: string[])',
		);
	});

	it("appends the output shape (top-level keys) and omits it when absent", () => {
		expect(
			operationSignature(
				probe(z.string(), z.object({ id: z.string(), n: z.number() })),
			),
		).toBe("probe(f: string) -> { id, n }");
		expect(outputType(probe(z.string()))).toBeUndefined();
	});

	it("renders a no-field input as empty parens", () => {
		expect(
			operationSignature(
				op({
					name: "ping",
					description: "d",
					input: z.object({}),
					handler: async () => null,
				}),
			),
		).toBe("ping()");
	});

	it("preserves a field's .describe() text", () => {
		const [only] = inputFields(probe(z.string().describe("the id")));
		expect(only?.description).toBe("the id");
	});
});

describe("operationHints (independent oracle: the verb convention)", () => {
	// Hand-authored truth, not read back from effectiveAnnotations.
	it.each([
		["list_projects", { readOnly: true, destructive: false }],
		["delete_project", { readOnly: false, destructive: true }],
		["set_translation", { readOnly: false, destructive: false }],
	] as const)("%s", (name, expected) => {
		const target = OPERATIONS.find((o) => o.name === name);
		expect(target, `operation ${name} must exist`).toBeDefined();
		expect(operationHints(target!)).toEqual(expected);
	});
});

describe("registry signature completeness", () => {
	describe.each(OPERATIONS)("$name", (operation) => {
		it("starts with the op name and lists exactly its input fields", () => {
			expect(
				operationSignature(operation).startsWith(`${operation.name}(`),
			).toBe(true);
			const keys = Object.keys(
				(operation.input as z.ZodObject<z.ZodRawShape>).shape ?? {},
			);
			expect(inputFields(operation).map((f) => f.name)).toEqual(keys);
		});
	});
});
