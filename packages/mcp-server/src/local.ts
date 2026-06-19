import http from "node:http";
import { TurjumanService, repositoryFromEnv } from "@turjuman/core";
import { processRequest } from "./handler.js";

/**
 * Run the MCP server locally over plain HTTP for development. Point it at a
 * local DynamoDB with `AWS_ENDPOINT_URL_DYNAMODB` (and dummy AWS creds), e.g.:
 *
 *   TURJUMAN_TABLE=Turjuman AWS_ENDPOINT_URL_DYNAMODB=http://localhost:8000 \
 *   AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local AWS_REGION=us-east-1 \
 *   node dist/local.js
 */
const repo = repositoryFromEnv();
const service = new TurjumanService(repo);
const port = Number(process.env.PORT ?? 3000);

http
  .createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      headers[k] = Array.isArray(v) ? v.join(",") : String(v ?? "");
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const result = await processRequest({
      method: req.method ?? "POST",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers,
      body: Buffer.concat(chunks).toString("utf8"),
      service: { repo, service },
    });
    res.writeHead(result.statusCode, result.headers);
    res.end(result.body ?? "");
  })
  .listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Turjuman MCP server listening on http://localhost:${port}/`);
  });
