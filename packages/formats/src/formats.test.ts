import { describe, expect, it } from "vitest";
import { getAdapter } from "./index.js";
import type { TranslationEntry } from "./types.js";

const entries: TranslationEntry[] = [
	{ key: "app.title", value: "Turjuman" },
	{ key: "app.nav.home", value: "Home" },
	{ key: "greeting", value: "Hello, {name}!" },
];

function roundTrip(formatId: string) {
	const adapter = getAdapter(formatId);
	const parsed = adapter.parse(adapter.serialize(entries));
	// These value-only formats also report a `plural` flag; compare key/value here.
	return parsed
		.map(({ key, value }) => ({ key, value }))
		.sort((a, b) => a.key.localeCompare(b.key));
}

describe("format adapters round-trip", () => {
	for (const id of ["json-nested", "json-flat", "yaml"]) {
		it(`${id} preserves keys and values`, () => {
			expect(roundTrip(id)).toEqual(
				entries.slice().sort((a, b) => a.key.localeCompare(b.key)),
			);
		});
	}
});

describe("nested JSON serialization", () => {
	it("nests dotted keys", () => {
		const out = getAdapter("json-nested").serialize([
			{ key: "a.b", value: "c" },
		]);
		expect(JSON.parse(out)).toEqual({ a: { b: "c" } });
	});
});

describe("flat JSON serialization", () => {
	it("keeps literal dotted keys", () => {
		const out = getAdapter("json-flat").serialize([{ key: "a.b", value: "c" }]);
		expect(JSON.parse(out)).toEqual({ "a.b": "c" });
	});
});

describe("getAdapter", () => {
	it("throws on unknown format", () => {
		expect(() => getAdapter("nope")).toThrow();
	});
});
