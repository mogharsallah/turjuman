import { createHash } from "node:crypto";

/**
 * A short, deterministic revision token for a base value. A key stores the token
 * of its current base value (`TranslationKey.sourceRevision`); a target cell
 * records the token it was translated against (`Translation.sourceRef`). When the
 * base value changes the token changes, so `sourceRef !== key.sourceRevision`
 * flags every dependent target as stale — no need to re-read the base value.
 *
 * Content-addressed, so re-importing an unchanged base value yields the same
 * token and does not spuriously stale its translations. An empty/absent base
 * value has the empty token `""` (no source yet).
 */
export function revisionOf(value: string | undefined): string {
	if (!value) return "";
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
