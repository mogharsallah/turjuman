import { OPERATIONS } from "@turjuman/sdk";
import { describe, expect, it } from "vitest";
import { allDocs } from "./corpus.js";
import { describeKnowledge, searchKnowledge } from "./search.js";
import { expandQuery } from "./synonyms.js";

/**
 * Layer 1 — the knowledge index (search / describe / corpus) as pure logic
 * (TESTING.md). Independent oracles throughout: hand-authored query→operation
 * expectations (domain knowledge, not read from the search code), hand-authored
 * field/error expectations, and registry-completeness loops over `OPERATIONS`.
 * The index is build-time static (operation signatures + a generated corpus), so
 * sharing it across `it`s is safe — there is no mutable state to flake.
 */

describe("expandQuery", () => {
	it("drops stopwords and single-character tokens", () => {
		const tokens = expandQuery("how do I add a new language").split(" ");
		for (const dropped of ["how", "do", "i", "a", "new"])
			expect(tokens).not.toContain(dropped);
	});

	it("expands domain synonyms (language -> locale)", () => {
		expect(expandQuery("language").split(" ")).toContain("locale");
	});

	it("yields an empty term for an all-stopword query", () => {
		expect(expandQuery("how do I use this")).toBe("");
	});
});

describe("searchKnowledge — recall (hand-authored query oracle)", () => {
	// Each row: a natural-language query and an operation a careful user expects to
	// find. The expectation is domain knowledge, independent of the ranking code.
	const CASES = [
		{ query: "add a new language", op: "add_locale" },
		{ query: "manage api keys", op: "create_api_key" },
		{ query: "stale translations to re-translate", op: "list_stale" },
		{ query: "run quality checks", op: "run_qa_checks" },
		{ query: "register a webhook for events", op: "add_webhook" },
		{ query: "set a translation value", op: "set_translation" },
	];

	describe.each(CASES)("'$query'", ({ query, op }) => {
		it("surfaces $op among the operation results", async () => {
			const r = await searchKnowledge(query, { kind: "operation" });
			expect(r.operations.map((o) => o.title)).toContain(op);
		});
	});
});

describe("searchKnowledge — response shape", () => {
	it("segments by kind and reports a true total (>= what is shown)", async () => {
		const r = await searchKnowledge("translation", { limit: 5 });
		expect(r.operations.every((o) => o.kind === "operation")).toBe(true);
		expect(r.docs.every((d) => d.kind !== "operation")).toBe(true);
		expect(r.operations.length).toBeLessThanOrEqual(5);
		expect(r.docs.length).toBeLessThanOrEqual(5);
		expect(r.total).toBeGreaterThanOrEqual(r.operations.length + r.docs.length);
	});

	it("operations carry a typed signature, not just a name (improvement #1)", async () => {
		const r = await searchKnowledge("translation", { kind: "operation" });
		expect(r.operations[0]?.signature).toMatch(/^\w+\(/);
	});

	it("the kind filter narrows to a single bucket", async () => {
		const r = await searchKnowledge("translation", { kind: "guide" });
		expect(r.operations).toHaveLength(0);
		expect(r.docs.every((d) => d.kind === "guide")).toBe(true);
	});

	it("is deterministic for the same query", async () => {
		const a = await searchKnowledge("set translation value");
		const b = await searchKnowledge("set translation value");
		expect(b.operations.map((o) => o.id)).toEqual(
			a.operations.map((o) => o.id),
		);
	});
});

describe("searchKnowledge — orientation (edge paths the ranking can't model)", () => {
	// An empty OR all-stopword query expands to nothing; Orama would match-all, so
	// both must route to the curated orientation rather than dump the corpus.
	describe.each([
		{ label: "empty query", q: "" },
		{ label: "all-stopword query", q: "how do I use this" },
	])("$label", ({ q }) => {
		it("returns the curated orientation, not a keyword ranking", async () => {
			const r = await searchKnowledge(q);
			expect(r.oriented).toBe(true);
			expect(r.operations).toHaveLength(0);
			expect(r.groups?.length).toBeGreaterThan(0);
			expect(r.docs.some((d) => d.kind === "concept")).toBe(true);
		});
	});
});

describe("describeKnowledge", () => {
	it("returns full typed detail for an operation id", () => {
		const d = describeKnowledge("op:set_translation");
		expect(d).toMatchObject({
			kind: "operation",
			name: "set_translation",
			readOnly: false,
			destructive: false,
		});
		if ("input" in d) {
			expect(d.input.find((f) => f.name === "projectId")).toMatchObject({
				type: "string",
				optional: false,
			});
			expect(d.input.find((f) => f.name === "namespace")).toMatchObject({
				optional: true,
			});
			expect(d.signature.startsWith("set_translation(")).toBe(true);
		}
	});

	it("reassembles the whole page for a doc id", () => {
		const guide = allDocs().find((x) => x.kind === "guide" && x.path);
		expect(guide, "expected at least one guide chunk").toBeDefined();
		const d = describeKnowledge(guide!.id);
		expect("text" in d && d.text.length).toBeTruthy();
		if ("path" in d) expect(d.path).toBe(guide!.path);
	});

	// Error path: an unknown id (operation OR doc) returns a soft {error}, which the
	// codemode transport turns into a NOT_FOUND tool error.
	it.each([
		["op:does_not_exist"],
		["guides/nope.mdx#_intro"],
		["totally-bogus"],
	])("returns an error for unknown id %s", (id) => {
		expect(describeKnowledge(id)).toHaveProperty("error");
	});
});

describe("corpus — registry completeness + integrity", () => {
	it("indexes every operation as an `op:<name>` doc", () => {
		const ids = new Set(allDocs().map((d) => d.id));
		for (const operation of OPERATIONS) {
			expect(
				ids.has(`op:${operation.name}`),
				`missing op doc for ${operation.name}`,
			).toBe(true);
		}
	});

	it("has globally unique chunk ids (the slug-collision guard)", () => {
		const ids = allDocs().map((d) => d.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("covers multiple Diátaxis doc subtrees", () => {
		const kinds = new Set(allDocs().map((d) => d.kind));
		for (const k of ["guide", "concept", "reference"])
			expect(kinds.has(k as never)).toBe(true);
	});

	it("every doc chunk carries id, title and source path", () => {
		for (const d of allDocs().filter((x) => x.kind !== "operation")) {
			expect(
				Boolean(d.id && d.title && d.path),
				`incomplete chunk ${d.id}`,
			).toBe(true);
		}
	});
});
