/**
 * Transport glue shared by the MCP and REST Lambda handlers. These are pure,
 * framework-agnostic string/object helpers (no AWS or HTTP-framework types) so
 * both transports parse bearer tokens, normalize headers, decode bodies, and
 * answer a missing key the same way — they can never drift.
 */

/** Extract the token from an `Authorization: Bearer <token>` header. */
export function parseBearer(header: string | undefined): string | undefined {
	if (!header) return undefined;
	return /^Bearer\s+(.+)$/i.exec(header.trim())?.[1];
}

/**
 * Lower-case every header key. API Gateway / Lambda Function URL header casing
 * is inconsistent, so handlers normalize before lookups (`headers.authorization`).
 */
export function lowerHeaderKeys(
	headers: Record<string, string | undefined>,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(headers))
		if (v !== undefined) out[k.toLowerCase()] = v;
	return out;
}

/** Decode a Lambda HTTP request body, honoring base64 transfer encoding. */
export function decodeBody(
	body: string | null | undefined,
	isBase64?: boolean,
): string {
	if (!body) return "";
	return isBase64 ? Buffer.from(body, "base64").toString("utf8") : body;
}

/** The `WWW-Authenticate` challenge value sent on a 401. */
export const BEARER_CHALLENGE = 'Bearer realm="Turjuman"';

/**
 * The standard 401 response for a missing/invalid API key. `extraHeaders` lets a
 * transport merge its own headers (e.g. the MCP server's CORS headers); the
 * content-type and challenge always win.
 */
export function unauthorized(extraHeaders: Record<string, string> = {}): {
	statusCode: 401;
	headers: Record<string, string>;
	body: string;
} {
	return {
		statusCode: 401,
		headers: {
			...extraHeaders,
			"content-type": "application/json",
			"www-authenticate": BEARER_CHALLENGE,
		},
		body: JSON.stringify({ error: "Invalid or missing API key" }),
	};
}
