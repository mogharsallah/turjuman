import { randomUUID } from "node:crypto";

/** Generate a globally-unique id with a short type prefix, e.g. `proj_a1b2c3...`. */
export function newId(prefix: string): string {
	return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

/** Build a URL/file-safe slug from an arbitrary name. */
export function slugify(input: string): string {
	return input
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
}
