/**
 * Shared AWS client configuration. Against real AWS this is just `{ region }` and
 * the SDK resolves credentials/endpoints the usual way. When `AWS_ENDPOINT_URL`
 * is set (e.g. LocalStack for e2e), we point every client at that endpoint —
 * mirroring scripts/e2e-deploy.mjs — so `status`/`teardown` and the SSM config
 * read/write are exercisable locally without a live account.
 */
export interface ClientConfig {
  region: string;
  endpoint?: string;
}

export function clientConfig(region: string): ClientConfig {
  const endpoint = process.env.AWS_ENDPOINT_URL;
  return endpoint ? { region, endpoint } : { region };
}
