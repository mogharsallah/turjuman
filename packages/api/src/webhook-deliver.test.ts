import http from "node:http";
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Webhook } from "@turjuman/core";
import { deliver, type DispatchEvent } from "./webhook.js";

/**
 * Hermetic coverage for a single webhook delivery: signing, HTTP-status handling,
 * and the per-delivery timeout. Uses a throwaway loopback server (no DynamoDB), so
 * it runs in the default `npm test`.
 */

let server: http.Server | undefined;
const event: DispatchEvent = { event: "translation.updated", data: { key: "greeting", locale: "fr" } };

function webhookFor(port: number, path = "/hook"): Webhook {
  return {
    projectId: "p1",
    id: "wh1",
    url: `http://127.0.0.1:${port}${path}`,
    events: ["translation.updated"],
    secret: "s3cr3t",
    createdAt: new Date().toISOString(),
  };
}

afterEach(() => {
  server?.close();
  server = undefined;
  vi.restoreAllMocks();
});

describe("webhook deliver", () => {
  it("POSTs an HMAC-signed payload to a healthy endpoint", async () => {
    const received = new Promise<{ headers: http.IncomingHttpHeaders; body: string }>((resolve) => {
      server = http
        .createServer((req, res) => {
          let body = "";
          req.on("data", (d) => (body += d));
          req.on("end", () => {
            res.statusCode = 200;
            res.end("ok");
            resolve({ headers: req.headers, body });
          });
        })
        .listen(0);
    });
    const port = (server!.address() as { port: number }).port;
    const webhook = webhookFor(port);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await deliver(webhook, "p1", event);

    const { headers, body } = await received;
    expect(headers["x-turjuman-event"]).toBe("translation.updated");
    const expected = "sha256=" + createHmac("sha256", webhook.secret).update(body).digest("hex");
    expect(headers["x-turjuman-signature"]).toBe(expected);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("treats a non-2xx response as a failed delivery", async () => {
    server = http
      .createServer((_req, res) => {
        res.statusCode = 500;
        res.end("boom");
      })
      .listen(0);
    const port = (server.address() as { port: number }).port;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Must not throw, but must log the failure (regression: a 500 was previously counted as success).
    await expect(deliver(webhookFor(port), "p1", event)).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("HTTP 500"));
  });

  it("times out a hanging endpoint instead of blocking forever", async () => {
    // Server accepts the connection but never responds.
    server = http.createServer(() => {}).listen(0);
    const port = (server.address() as { port: number }).port;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const start = Date.now();
    await expect(deliver(webhookFor(port), "p1", event, 150)).resolves.toBeUndefined();
    expect(Date.now() - start).toBeLessThan(5000);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("webhook delivery"),
      expect.stringContaining("timeout"),
    );
  });
});
