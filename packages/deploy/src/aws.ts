/**
 * Shared AWS client configuration. Against real AWS this is just `{ region }` and
 * the SDK resolves credentials/endpoints the usual way. When `AWS_ENDPOINT_URL`
 * is set (e.g. LocalStack for e2e), we point every client at that endpoint —
 * mirroring scripts/e2e-deploy.mjs — so `status`/`teardown` are exercisable
 * locally without a live account.
 */
export interface ClientConfig {
  region: string;
  endpoint?: string;
  /** S3 under LocalStack needs path-style addressing (no per-bucket virtual hosts). */
  forcePathStyle?: boolean;
}

export function clientConfig(region: string, opts: { s3?: boolean } = {}): ClientConfig {
  const endpoint = process.env.AWS_ENDPOINT_URL;
  if (!endpoint) return { region };
  return { region, endpoint, ...(opts.s3 ? { forcePathStyle: true } : {}) };
}
