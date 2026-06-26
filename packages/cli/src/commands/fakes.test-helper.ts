import type { ApiClient } from "../client.js";
import type { OutputSink } from "../output.js";

/** A capturing OutputSink for assertions. */
export function capturingSink(): {
	sink: OutputSink;
	lines: string[];
	notes: string[];
	result: () => unknown;
} {
	const lines: string[] = [];
	const notes: string[] = [];
	let result: unknown;
	return {
		lines,
		notes,
		result: () => result,
		sink: {
			line: (t) => lines.push(t),
			note: (t) => notes.push(t),
			result: (p) => {
				result = p;
			},
			flush: () => {},
		},
	};
}

/** Build a fake ApiClient from a partial set of methods. */
export function fakeApi(methods: Partial<ApiClient>): ApiClient {
	return methods as unknown as ApiClient;
}
