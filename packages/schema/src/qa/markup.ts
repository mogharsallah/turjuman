/**
 * Markup integrity helpers. Translation strings are fragments, not documents, so
 * a tolerant regex tag-token multiset beats a full HTML parser: we compare the
 * *names* of opening/closing/self-closing tags between base and target, ignoring
 * attributes (whose values are often legitimately translated). Mismatched counts
 * — a dropped `</b>`, an added `<i>` — are what we want to catch.
 */

const TAG_RE = /<\s*(\/?)\s*([A-Za-z][A-Za-z0-9-]*)[^>]*?(\/?)\s*>/g;

/** Multiset of tag tokens by normalized name, e.g. `<b>`→"b", `</b>`→"/b", `<br/>`→"br/". */
export function tagTokens(value: string): Map<string, number> {
	const counts = new Map<string, number>();
	for (const m of value.matchAll(TAG_RE)) {
		const closing = m[1] === "/";
		const selfClosing = m[3] === "/";
		const name = m[2]!.toLowerCase();
		const token = closing ? `/${name}` : selfClosing ? `${name}/` : name;
		counts.set(token, (counts.get(token) ?? 0) + 1);
	}
	return counts;
}

/**
 * Compare two tag multisets and return a human-readable description of the
 * differences, or `null` when they match. Reports missing and extra tokens.
 */
export function compareTags(
	base: Map<string, number>,
	target: Map<string, number>,
): string | null {
	const missing: string[] = [];
	const extra: string[] = [];
	for (const [token, n] of base) {
		const got = target.get(token) ?? 0;
		if (got < n) missing.push(`<${token}>×${n - got}`);
	}
	for (const [token, n] of target) {
		const had = base.get(token) ?? 0;
		if (n > had) extra.push(`<${token}>×${n - had}`);
	}
	if (missing.length === 0 && extra.length === 0) return null;
	const parts: string[] = [];
	if (missing.length) parts.push(`missing ${missing.join(", ")}`);
	if (extra.length) parts.push(`unexpected ${extra.join(", ")}`);
	return parts.join("; ");
}
