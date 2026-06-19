import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadEnv } from "./helpers/env.js";
import { uniq } from "./helpers/fixtures.js";
import { makeMcpClient } from "./helpers/mcp.js";
import { type CapturedRequest, startReceiver } from "./helpers/receiver.js";

/**
 * P1 — webhook delivery through the real DynamoDB Streams -> WebhookFunction
 * event-source-mapping (the only place the ESM is exercised end-to-end):
 *  - event coverage: each change type maps to the right HMAC-signed event;
 *  - filtering & removal: a narrowly-subscribed webhook ignores other events,
 *    and a removed webhook stops receiving entirely.
 */
const env = loadEnv();
const e = env ?? { mcpUrl: "", apiUrl: "", tableName: "", apiKey: "" };

const WAIT = 90_000;
const byEvent = (name: string) => (r: CapturedRequest) => r.headers["x-turjuman-event"] === name;

function expectSigned(delivery: CapturedRequest, secret: string): void {
  const expected = "sha256=" + createHmac("sha256", secret).update(delivery.body).digest("hex");
  expect(delivery.headers["x-turjuman-signature"]).toBe(expected);
}

describe.skipIf(!env)("P1 webhooks (Streams -> Lambda)", () => {
  const mcp = makeMcpClient(e.mcpUrl, e.apiKey);

  it("delivers a distinct signed event for each change type", async () => {
    const receiver = await startReceiver();
    try {
      const project = await mcp<{ id: string }>("create_project", {
        name: uniq("Hook Coverage"),
        baseLocale: "en",
      });
      // Register BEFORE any triggering write (the ESM starts at LATEST).
      const webhook = await mcp<{ id: string; secret: string }>("add_webhook", {
        projectId: project.id,
        url: `http://host.docker.internal:${receiver.port}/hook`,
        events: ["*"],
      });

      // One change of each kind.
      await mcp("create_key", { projectId: project.id, name: "greeting", description: "Hi" });
      await mcp("add_locale", { projectId: project.id, code: "fr" });
      await mcp("bulk_set_translations", {
        projectId: project.id,
        locale: "fr",
        entries: [{ name: "greeting", value: "Bonjour" }],
      });
      await mcp("delete_key", { projectId: project.id, name: "greeting", confirm: true });

      // waitFor scans all deliveries without consuming, so these can race freely.
      // Match the fr locale.added specifically: creating the project also emits a
      // locale.added for the base locale ("en"), which the stream poller can
      // deliver once the webhook row exists — so we can't assume the first one is fr.
      const [created, localeAdded, updated, deleted] = await Promise.all([
        receiver.waitFor(byEvent("key.created"), WAIT),
        receiver.waitFor((r) => byEvent("locale.added")(r) && r.body.includes('"code":"fr"'), WAIT),
        receiver.waitFor(byEvent("translation.updated"), WAIT),
        receiver.waitFor(byEvent("key.deleted"), WAIT),
      ]);

      for (const d of [created, localeAdded, updated, deleted]) expectSigned(d, webhook.secret);
      expect(JSON.parse(created.body)).toMatchObject({
        event: "key.created",
        projectId: project.id,
        data: { key: "greeting" },
      });
      expect(JSON.parse(localeAdded.body)).toMatchObject({
        event: "locale.added",
        projectId: project.id,
        data: { code: "fr" },
      });
      expect(JSON.parse(updated.body)).toMatchObject({
        event: "translation.updated",
        data: { key: "greeting", locale: "fr" },
      });
      expect(JSON.parse(deleted.body)).toMatchObject({
        event: "key.deleted",
        data: { key: "greeting" },
      });
    } finally {
      receiver.close();
    }
  });

  it("respects event filtering and stops delivering after removal", async () => {
    const filtered = await startReceiver(); // subscribes to translation.updated only
    const control = await startReceiver(); // subscribes to "*" — a delivery fence
    try {
      const project = await mcp<{ id: string }>("create_project", {
        name: uniq("Hook Filter"),
        baseLocale: "en",
      });
      await mcp("add_locale", { projectId: project.id, code: "fr" });

      const narrow = await mcp<{ id: string }>("add_webhook", {
        projectId: project.id,
        url: `http://host.docker.internal:${filtered.port}/hook`,
        events: ["translation.updated"],
      });
      await mcp("add_webhook", {
        projectId: project.id,
        url: `http://host.docker.internal:${control.port}/hook`,
        events: ["*"],
      });

      // A key.created (ignored by the narrow hook) and a translation.updated.
      await mcp("create_key", { projectId: project.id, name: "alpha", description: "A" });
      await mcp("bulk_set_translations", {
        projectId: project.id,
        locale: "fr",
        entries: [{ name: "alpha", value: "Alpha-fr" }],
      });

      // Fence: the control hook proves BOTH events flowed through the pipeline.
      await control.waitFor(byEvent("key.created"), WAIT);
      await control.waitFor((r) => byEvent("translation.updated")(r) && r.body.includes("alpha"), WAIT);
      // The narrow hook got the translation but never the key.created.
      await filtered.waitFor(byEvent("translation.updated"), WAIT);
      expect(filtered.received().some(byEvent("key.created"))).toBe(false);

      // Remove the narrow hook, then trigger another translation.updated.
      await mcp("remove_webhook", { projectId: project.id, webhookId: narrow.id });
      await mcp("create_key", { projectId: project.id, name: "beta", description: "B" });
      await mcp("bulk_set_translations", {
        projectId: project.id,
        locale: "fr",
        entries: [{ name: "beta", value: "Beta-fr" }],
      });

      // Fence again on the control hook for the post-removal event...
      await control.waitFor((r) => r.body.includes("beta"), WAIT);
      // ...by which point the removed hook must not have seen anything about beta.
      expect(filtered.received().some((r) => r.body.includes("beta"))).toBe(false);
    } finally {
      filtered.close();
      control.close();
    }
  });
});
