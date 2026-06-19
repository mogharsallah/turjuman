// ---- pagination cursor (opaque base64 of the DynamoDB LastEvaluatedKey) ------

import { validation } from "@turjuman/schema";

export function encodeCursor(key: Record<string, unknown> | undefined): string | undefined {
  return key ? Buffer.from(JSON.stringify(key)).toString("base64url") : undefined;
}

export function decodeCursor(cursor: string | undefined): Record<string, unknown> | undefined {
  if (!cursor) return undefined;
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw validation("Invalid pagination cursor");
  }
}
