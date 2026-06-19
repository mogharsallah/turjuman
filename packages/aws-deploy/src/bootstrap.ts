import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { Repository, bootstrapOwner } from "@turjuman/core";

/**
 * Create the first OWNER directly against the freshly-deployed table, returning
 * the initial API key (shown once). This replaces the old trigger-less
 * BootstrapFunction: we talk to DynamoDB from the operator's machine using the
 * same `bootstrapOwner` core helper as local dev. The org-already-populated
 * guard lives in core, so re-running is safe.
 */
export async function bootstrapFirstOwner(opts: {
  region: string;
  tableName: string;
  email: string;
  name: string;
}): Promise<{ userId: string; email: string; apiKey: string } | null> {
  const client = new DynamoDBClient({ region: opts.region });
  const repo = new Repository({ tableName: opts.tableName, client });
  try {
    const { user, secret } = await bootstrapOwner(repo, { email: opts.email, name: opts.name });
    return { userId: user.id, email: user.email, apiKey: secret };
  } catch (err: any) {
    // Org already has users — bootstrap is a no-op. Surface as null so the caller
    // can tell the operator their existing key still works.
    if (/already has users|already bootstrapped/i.test(err?.message ?? "")) return null;
    throw err;
  }
}
