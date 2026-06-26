import { type Operation, effectiveAnnotations } from "@turjuman/sdk";
import type { z } from "zod";
import type { FieldInfo } from "./types.js";

/**
 * Render a zod input schema into a compact, model-facing TypeScript-ish
 * signature. This is improvement #1 over the old name-only search (which exposed only
 * field *names*): the model gets real arg types + optionality + return shape, so
 * it can write `run_code` correctly without first probing.
 *
 * We classify by `zod`'s internal `_def.typeName` (stable across zod 3) and fall
 * back to `unknown` for anything exotic — a readable approximation, not a
 * complete type printer.
 */

// zod keeps its discriminant + payload on `_def`; it is not in the public types,
// so we read it through a narrow local shape rather than `any` everywhere.
interface ZodDef {
  typeName?: string;
  description?: string;
  // Unwrappable inner schemas (optional/nullable/default/effects/array/...).
  innerType?: z.ZodTypeAny;
  type?: z.ZodTypeAny;
  schema?: z.ZodTypeAny;
  // Enum / literal / union payloads.
  values?: readonly string[];
  value?: unknown;
  options?: z.ZodTypeAny[];
  valueType?: z.ZodTypeAny;
}

function def(schema: z.ZodTypeAny): ZodDef {
  return (schema as unknown as { _def: ZodDef })._def ?? {};
}

/** Peel optional/nullable/default/effects/branded wrappers off a schema, so the
 * field's *type* is rendered from its core while optionality is tracked apart. */
function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let s = schema;
  for (let i = 0; i < 10; i++) {
    const d = def(s);
    const inner = d.innerType ?? d.schema;
    if (
      (d.typeName === "ZodOptional" ||
        d.typeName === "ZodNullable" ||
        d.typeName === "ZodDefault" ||
        d.typeName === "ZodEffects" ||
        d.typeName === "ZodBranded" ||
        d.typeName === "ZodReadonly") &&
      inner
    ) {
      s = inner;
      continue;
    }
    break;
  }
  return s;
}

/** Whether a field may be omitted by the caller (optional or has a default). */
function isOptional(schema: z.ZodTypeAny): boolean {
  let s = schema;
  for (let i = 0; i < 10; i++) {
    const d = def(s);
    if (d.typeName === "ZodOptional" || d.typeName === "ZodDefault") return true;
    // Look through transforms/brands that don't change requiredness.
    const inner = d.typeName === "ZodEffects" || d.typeName === "ZodBranded" || d.typeName === "ZodReadonly"
      ? (d.innerType ?? d.schema)
      : undefined;
    if (!inner) return false;
    s = inner;
  }
  return false;
}

/** Render a (already-unwrapped) zod type as a short type string. */
function renderType(schema: z.ZodTypeAny, depth = 0): string {
  const core = unwrap(schema);
  const d = def(core);
  switch (d.typeName) {
    case "ZodString":
      return "string";
    case "ZodNumber":
      return "number";
    case "ZodBoolean":
      return "boolean";
    case "ZodDate":
      return "Date";
    case "ZodLiteral":
      return JSON.stringify(d.value);
    case "ZodEnum":
      return (d.values ?? []).map((v) => JSON.stringify(v)).join(" | ") || "string";
    case "ZodNativeEnum":
      return "enum";
    case "ZodArray": {
      const el = d.type ?? d.innerType;
      return `${el ? renderType(el, depth + 1) : "unknown"}[]`;
    }
    case "ZodUnion":
      return (d.options ?? []).map((o) => renderType(o, depth + 1)).join(" | ") || "unknown";
    case "ZodRecord":
      return `Record<string, ${d.valueType ? renderType(d.valueType, depth + 1) : "unknown"}>`;
    case "ZodObject": {
      // Keep nesting shallow: top-level objects render their keys with types;
      // deeper objects collapse to `{…}` so a return shape stays one line.
      if (depth > 0) return "{…}";
      const shape = objectShape(core);
      const keys = Object.keys(shape);
      if (keys.length === 0) return "{}";
      return `{ ${keys.join(", ")} }`;
    }
    default:
      return "unknown";
  }
}

/** The shape map of a ZodObject, or `{}` for a non-object. */
function objectShape(schema: z.ZodTypeAny): Record<string, z.ZodTypeAny> {
  const core = unwrap(schema);
  if (def(core).typeName !== "ZodObject") return {};
  const shapeFn = (core as unknown as { shape?: Record<string, z.ZodTypeAny> }).shape;
  return shapeFn ?? {};
}

/** The input fields of an operation, with rendered type + optionality + any
 * `.describe()` text. Empty when the input is not an object. */
export function inputFields(op: Operation): FieldInfo[] {
  const shape = objectShape(op.input);
  return Object.entries(shape).map(([name, field]) => ({
    name,
    type: renderType(field),
    optional: isOptional(field),
    description: def(field).description || def(unwrap(field)).description,
  }));
}

/** Render the operation's result type (its `output` schema) compactly, or
 * `undefined` when the operation declares no structured output. */
export function outputType(op: Operation): string | undefined {
  return op.output ? renderType(op.output) : undefined;
}

/**
 * A compact one-line signature, e.g.
 * `set_translation(projectId: string, name: string, locale: string, value: string) -> Translation`.
 * Optional fields render with a trailing `?`. The return shape is the output
 * schema's rendered type when present.
 */
export function operationSignature(op: Operation): string {
  const params = inputFields(op)
    .map((f) => `${f.name}${f.optional ? "?" : ""}: ${f.type}`)
    .join(", ");
  const out = outputType(op);
  return `${op.name}(${params})${out ? ` -> ${out}` : ""}`;
}

/** Behaviour hints, reusing the SDK's single classification (do not duplicate
 * the read-only/destructive policy here). */
export function operationHints(op: Operation): { readOnly: boolean; destructive: boolean } {
  const ann = effectiveAnnotations(op);
  return { readOnly: ann.readOnlyHint === true, destructive: ann.destructiveHint === true };
}
