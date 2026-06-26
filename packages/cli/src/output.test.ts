import { afterEach, describe, expect, it, vi } from "vitest";
import { createSink, wantsJson } from "./output.js";

function captureStreams() {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const o = vi
		.spyOn(process.stdout, "write")
		.mockImplementation((c: string | Uint8Array) => {
			stdout.push(String(c));
			return true;
		});
	const e = vi
		.spyOn(process.stderr, "write")
		.mockImplementation((c: string | Uint8Array) => {
			stderr.push(String(c));
			return true;
		});
	return {
		stdout,
		stderr,
		restore: () => [o, e].forEach((s) => s.mockRestore()),
	};
}

describe("wantsJson", () => {
	it("detects the --json flag in argv", () => {
		expect(wantsJson(["node", "cli", "push", "--json"])).toBe(true);
		expect(wantsJson(["node", "cli", "push"])).toBe(false);
	});
});

describe("TextSink", () => {
	let cap: ReturnType<typeof captureStreams>;
	afterEach(() => cap.restore());

	it("writes lines to stdout, notes to stderr, and emits nothing for result/flush", () => {
		cap = captureStreams();
		const out = createSink(false);
		out.line("hello");
		out.note("diag");
		out.result({ command: "x" });
		out.flush();
		expect(cap.stdout.join("")).toBe("hello\n");
		expect(cap.stderr.join("")).toBe("diag\n");
	});
});

describe("JsonSink", () => {
	let cap: ReturnType<typeof captureStreams>;
	afterEach(() => cap.restore());

	it("suppresses lines, routes notes to stderr, and emits one JSON document on flush", () => {
		cap = captureStreams();
		const out = createSink(true);
		out.line("hello");
		out.note("diag");
		out.result({ command: "push", files: [] });
		out.flush();
		expect(cap.stderr.join("")).toBe("diag\n");
		const stdout = cap.stdout.join("");
		expect(JSON.parse(stdout)).toEqual({ command: "push", files: [] });
	});
});
