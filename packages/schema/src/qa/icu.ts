import type { MessageFormatElement } from "@formatjs/icu-messageformat-parser";
import { parse, TYPE } from "@formatjs/icu-messageformat-parser";
import { parseIcuPlural } from "../plural.js";

/**
 * ICU helpers for the QA engine, built on the same `@formatjs` parser the
 * format adapters use. HTML/XML markup is the `markup` check's concern, so we
 * parse with `ignoreTag: true` here — an unbalanced `<b>` should not register as
 * an ICU syntax error.
 */

const PARSE_OPTS = { ignoreTag: true, requiresOtherClause: false } as const;

/** Result of a tolerant ICU parse: ok, or the parser's error message. */
export type IcuParseResult = { ok: true } | { ok: false; error: string };

/** Validate that `value` is parseable ICU MessageFormat. */
export function parseIcuSafe(value: string): IcuParseResult {
	try {
		parse(value, PARSE_OPTS);
		return { ok: true };
	} catch (e) {
		return { ok: false, error: (e as Error).message };
	}
}

function walk(els: MessageFormatElement[], out: Set<string>): void {
	for (const el of els) {
		switch (el.type) {
			case TYPE.argument:
			case TYPE.number:
			case TYPE.date:
			case TYPE.time:
				out.add(el.value);
				break;
			case TYPE.select:
			case TYPE.plural:
				out.add(el.value);
				for (const opt of Object.values(el.options)) walk(opt.value, out);
				break;
			case TYPE.tag:
				walk(el.children, out);
				break;
			// literal and pound (`#`) carry no argument name.
		}
	}
}

/**
 * The set of argument/variable names referenced in a message (across all plural
 * and select branches). `#` is the plural count substitution, not an argument,
 * so it is never included. Returns `null` when the value is unparseable.
 */
export function collectArgNames(value: string): Set<string> | null {
	let ast: MessageFormatElement[];
	try {
		ast = parse(value, PARSE_OPTS);
	} catch {
		return null;
	}
	const names = new Set<string>();
	walk(ast, names);
	return names;
}

/**
 * The inner messages of an ICU plural, in CLDR order, or `null` when `value`
 * isn't a single plural message. Reuses the canonical plural parser.
 */
export function pluralForms(
	value: string,
): { varName: string; forms: Record<string, string> } | null {
	return parseIcuPlural(value);
}
