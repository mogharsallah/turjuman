/**
 * Generic local dev server for the Turjuman transports. Runs the *real* Lambda
 * entry point (`handler.ts`) — not a parallel HTTP bridge — by synthesizing a
 * Lambda Function URL (payload format 2.0) event from each incoming Node
 * request and serializing the handler's result back. One harness drives both the
 * MCP server and the REST API, so the dev loop exercises the exact code path
 * (event parsing, header-lowercasing, base64 body decode) that production does.
 *
 * Run under tsx with tsconfig.dev.json so the handler's `@turjuman/*` imports
 * resolve to package `src` for instant cross-package hot reload:
 *
 *   PORT=3000 tsx watch --tsconfig tsconfig.dev.json \
 *     scripts/dev-serve.ts packages/mcp-server/src/handler.ts
 */
import http from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface LambdaResult {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
}
type Handler = (event: unknown, context?: unknown) => Promise<LambdaResult>;

async function main() {
  const modulePath = process.argv[2];
  if (!modulePath) {
    console.error("Usage: tsx scripts/dev-serve.ts <path-to-handler-module>");
    process.exit(1);
  }

  const mod = (await import(pathToFileURL(resolve(modulePath)).href)) as { handler?: Handler };
  const handler = mod.handler;
  if (typeof handler !== "function") {
    console.error(`Module ${modulePath} does not export a "handler" function.`);
    process.exit(1);
  }

  const port = Number(process.env.PORT ?? 3000);

  http
    .createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const rawBody = Buffer.concat(chunks);

    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(",") : String(v);
    }
    const method = req.method ?? "GET";
    const hasBody = rawBody.length > 0;

    // Lambda Function URL payload format 2.0 — the shape both handlers accept.
    const event = {
      version: "2.0",
      routeKey: "$default",
      rawPath: url.pathname,
      rawQueryString: url.search.replace(/^\?/, ""),
      cookies: [],
      headers,
      requestContext: {
        http: { method, path: url.pathname, sourceIp: "127.0.0.1", userAgent: headers["user-agent"] ?? "" },
      },
      body: hasBody ? rawBody.toString("base64") : undefined,
      isBase64Encoded: hasBody,
    };

    try {
      const result = await handler(event);
      res.writeHead(result.statusCode, result.headers ?? {});
      if (result.body !== undefined) {
        res.end(result.isBase64Encoded ? Buffer.from(result.body, "base64") : result.body);
      } else {
        res.end();
      }
    } catch (err) {
      console.error("dev-serve: handler threw", err);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "dev-serve internal error" }));
    }
    })
    .listen(port, () => {
      console.log(`Turjuman dev server (${modulePath}) listening on http://localhost:${port}/`);
    });
}

main();
