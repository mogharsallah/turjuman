import type { QaContext, QaFinding, QaSeverity } from "../types.js";

/** Build a finding for `ctx`, filling in the key/locale coordinates. */
export function finding(
	ctx: QaContext,
	checkId: string,
	severity: QaSeverity,
	message: string,
	value?: string,
): QaFinding {
	return {
		checkId,
		severity,
		namespace: ctx.namespace,
		keyName: ctx.key.name,
		localeCode: ctx.localeCode,
		message,
		value,
	};
}

/** Truncate a value for inclusion in a finding message/snippet. */
export function snippet(value: string, max = 80): string {
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
