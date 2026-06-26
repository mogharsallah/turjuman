import { validation } from "@turjuman/schema";
import { androidAdapter } from "./android.js";
import { arbAdapter } from "./arb.js";
import { csvAdapter } from "./csv.js";
import { iosStringsAdapter } from "./ios-strings.js";
import { iosStringsdictAdapter } from "./ios-stringsdict.js";
import { flatJsonAdapter, nestedJsonAdapter } from "./json.js";
import { poAdapter } from "./po.js";
import { propertiesAdapter } from "./properties.js";
import type { FormatAdapter } from "./types.js";
import { xliff12Adapter, xliff20Adapter } from "./xliff.js";
import { yamlAdapter } from "./yaml.js";

export { flatten, unflatten } from "./nesting.js";
export * from "./types.js";

/** All supported formats. */
export const ADAPTERS: FormatAdapter[] = [
	nestedJsonAdapter,
	flatJsonAdapter,
	yamlAdapter,
	arbAdapter,
	propertiesAdapter,
	csvAdapter,
	androidAdapter,
	iosStringsAdapter,
	iosStringsdictAdapter,
	poAdapter,
	xliff12Adapter,
	xliff20Adapter,
];

const BY_ID = new Map(ADAPTERS.map((a) => [a.id, a]));

export function getAdapter(id: string): FormatAdapter {
	const adapter = BY_ID.get(id);
	if (!adapter) {
		throw validation(
			`Unknown format "${id}". Available: ${[...BY_ID.keys()].join(", ")}`,
		);
	}
	return adapter;
}

export function listFormats(): {
	id: string;
	label: string;
	extensions: string[];
}[] {
	return ADAPTERS.map(({ id, label, extensions }) => ({
		id,
		label,
		extensions,
	}));
}
