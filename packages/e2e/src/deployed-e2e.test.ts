import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type E2EEnv, loadEnv, modeOf } from "./helpers/env.js";
import { makeOpClient } from "./helpers/mcp.js";
import { type CapturedRequest, startReceiver } from "./helpers/receiver.js";

/**
 * Full deployed end-to-end test — deployed mode only (it needs the real Function
 * URLs and DynamoDB Streams → webhook ESM, which the in-process mode can't
 * provide). The CDK stack is deployed into LocalStack by `scripts/e2e-deploy.mjs`,
 * which writes the resolved Function URLs and a seeded API key to .e2e/env.json.
 * This spec is a black box: it only talks HTTP to the deployed Lambda Function
 * URLs and asserts that the real DynamoDB Streams -> WebhookFunction
 * event-source-mapping delivers a signed webhook.
 *
 *   npm run localstack:up && npm run e2e:deploy && npm run e2e:test
 */
const env = loadEnv();
const mode = modeOf(env);

// `skipIf` still evaluates this callback at collection time, so fall back to a
// blank env to avoid dereferencing null when the deploy step hasn't run.
const e: E2EEnv = env ?? { mcpUrl: "", apiUrl: "", tableName: "", apiKey: "" };

describe.skipIf(mode !== "deployed")("deployed e2e against LocalStack", () => {
	const mcp = makeOpClient(e.mcpUrl, e.apiKey);

	it("serves the REST API meta endpoint over its Function URL", async () => {
		const res = await fetch(e.apiUrl);
		expect(res.ok).toBe(true);
		expect(await res.json()).toMatchObject({ name: "turjuman" });
	});

	it("drives MCP + REST and delivers a real DynamoDB Streams -> Lambda webhook", async () => {
		const receiver = await startReceiver();
		try {
			// --- create a project + locale through the deployed MCP Function URL ---
			const project = await mcp<{ id: string }>("create_project", {
				name: "Deployed E2E",
				baseLocale: "en",
			});
			expect(project.id).toMatch(/^proj_/);
			await mcp("add_locale", { projectId: project.id, code: "fr" });

			// --- register a webhook BEFORE writing (the ESM starts at LATEST) ---
			const webhook = await mcp<{ secret: string }>("add_webhook", {
				projectId: project.id,
				url: `http://host.docker.internal:${receiver.port}/hook`,
				events: ["translation.updated"],
			});
			expect(webhook.secret).toMatch(/^whsec_/);

			await mcp("create_key", {
				projectId: project.id,
				name: "greeting",
				description: "Greeting shown on the home screen",
			});

			// --- the deployed REST API Function URL sees the same data ---
			const list = await fetch(`${e.apiUrl}v1/projects`, {
				headers: { authorization: `Bearer ${e.apiKey}` },
			});
			expect(list.ok).toBe(true);
			const body = (await list.json()) as { projects: { id: string }[] };
			expect(body.projects.map((p) => p.id)).toContain(project.id);

			// --- writing a translation produces a stream record; the deployed
			//     WebhookFunction (DynamoDB Streams ESM) delivers a signed POST ---
			await mcp("bulk_set_translations", {
				projectId: project.id,
				locale: "fr",
				entries: [{ name: "greeting", value: "Bonjour" }],
			});

			// Scan for the translation.updated delivery rather than consuming the first
			// arrival: with the stream poller reading from the horizon, an earlier
			// (filtered) record could still surface, and a redelivered batch could
			// duplicate — waitFor tolerates both, next() would not.
			const isTranslationUpdated = (r: CapturedRequest) =>
				r.headers["x-turjuman-event"] === "translation.updated";
			const delivery = await receiver.waitFor(isTranslationUpdated, 90_000);
			expect(delivery.headers["x-turjuman-event"]).toBe("translation.updated");
			const expectedSig =
				"sha256=" +
				createHmac("sha256", webhook.secret)
					.update(delivery.body)
					.digest("hex");
			expect(delivery.headers["x-turjuman-signature"]).toBe(expectedSig);
			expect(JSON.parse(delivery.body)).toMatchObject({
				event: "translation.updated",
				projectId: project.id,
				data: { locale: "fr" },
			});
		} finally {
			receiver.close();
		}
	});
});
