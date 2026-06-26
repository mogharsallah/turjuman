import { describe, expect, it } from "vitest";
import type { ProjectConfig } from "../config.js";
import { capturingSink, fakeApi } from "./fakes.test-helper.js";
import { runPull } from "./pull.js";

const config: ProjectConfig = {
	projectId: "proj_1",
	targets: [
		{ format: "json-flat", path: "web/{locale}.json", namespace: "default" },
		{
			format: "json-flat",
			path: "marketing/{locale}.json",
			namespace: "marketing",
		},
	],
};

describe("runPull", () => {
	it("writes one file per (locale, target), filtering entries by namespace", async () => {
		const api = fakeApi({
			listLocales: async () => ({ locales: [{ code: "en" }] }) as never,
			exportBundle: async () =>
				({
					entries: [
						{ key: "a", value: "A", namespace: "default" },
						{ key: "promo", value: "Sale", namespace: "marketing" },
					],
				}) as never,
		});
		const cap = capturingSink();
		const written: Record<string, string> = {};
		const files = await runPull(api, config, {}, cap.sink, (p, c) => {
			written[p] = c;
		});

		expect(Object.keys(written).sort()).toEqual([
			"marketing/en.json",
			"web/en.json",
		]);
		expect(JSON.parse(written["web/en.json"]!)).toEqual({ a: "A" });
		expect(JSON.parse(written["marketing/en.json"]!)).toEqual({
			promo: "Sale",
		});
		expect(files.find((f) => f.path === "web/en.json")).toMatchObject({
			namespace: "default",
			entries: 1,
		});
	});

	it("passes working/excludeStale through and records them in the result", async () => {
		let captured: { working?: boolean; excludeStale?: boolean } | undefined;
		const api = fakeApi({
			listLocales: async () => ({ locales: [{ code: "en" }] }) as never,
			exportBundle: async (
				_p: string,
				_l: string,
				opts?: { working?: boolean; excludeStale?: boolean },
			) => {
				captured = opts;
				return { entries: [] } as never;
			},
		});
		const cap = capturingSink();
		await runPull(
			api,
			config,
			{ working: true, excludeStale: true },
			cap.sink,
			() => {},
		);
		expect(captured).toEqual({ working: true, excludeStale: true });
		expect(cap.result()).toMatchObject({
			command: "pull",
			working: true,
			excludeStale: true,
		});
	});
});
