import http from "node:http";
import { TurjumanService, repositoryFromEnv } from "@turjuman/core";
import { createApp } from "./router.js";

/** Run the REST API locally over plain HTTP for development (see mcp-server/local.ts).
 * Bridges Node's req/res to the Hono app via the web Fetch API (Node 20+ globals). */
const repo = repositoryFromEnv();
const service = new TurjumanService(repo);
const app = createApp({ repo, service });
const port = Number(process.env.PORT ?? 4000);

http
  .createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(",") : v);
    }
    const method = req.method ?? "GET";
    const hasBody = method !== "GET" && method !== "HEAD" && chunks.length > 0;
    const response = await app.fetch(
      new Request(`http://localhost:${port}${req.url ?? "/"}`, {
        method,
        headers,
        body: hasBody ? Buffer.concat(chunks) : undefined,
      }),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  })
  .listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Turjuman REST API listening on http://localhost:${port}/`);
  });
