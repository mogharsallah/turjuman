/** Result of a REST call against the deployed API Function URL. */
export interface RestResponse<T = unknown> {
  status: number;
  ok: boolean;
  json: T;
}

/**
 * Minimal REST client for the deployed API Function URL. The URL carries a
 * trailing slash (as LocalStack/AWS mint it), so paths are passed without a
 * leading slash, e.g. `rest("GET", "v1/projects")`.
 */
export function makeRestClient(apiUrl: string, defaultKey?: string) {
  const base = apiUrl.endsWith("/") ? apiUrl : `${apiUrl}/`;
  return async function rest<T = unknown>(
    method: string,
    path: string,
    opts: { body?: unknown; apiKey?: string | null } = {},
  ): Promise<RestResponse<T>> {
    const key = opts.apiKey === null ? undefined : (opts.apiKey ?? defaultKey);
    const res = await fetch(base + path.replace(/^\//, ""), {
      method,
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    let json: T;
    try {
      json = (await res.json()) as T;
    } catch {
      json = undefined as T;
    }
    return { status: res.status, ok: res.ok, json };
  };
}
