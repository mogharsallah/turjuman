// The single source of the dev CloudFormation stack name. Each working copy (git
// worktree, separate clone, …) stamps itself once with a generated name persisted
// in a gitignored `.turjuman-dev` marker at its repo root, then reuses it forever —
// so many sessions can share one LocalStack without colliding. Independent of
// branch/dir/worktree internals. Reused by dev / dev:deploy / dev:teardown.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	".turjuman-dev",
);

// create:true  => generate + persist on first run (dev / dev:deploy).
// create:false => read-only; returns undefined when nothing is stamped yet (dev:teardown).
export function devStackName({ create = false } = {}) {
	if (process.env.TURJUMAN_DEV_STACK) return process.env.TURJUMAN_DEV_STACK;
	if (existsSync(MARKER)) {
		const name = readFileSync(MARKER, "utf8").trim();
		if (name) return name;
	}
	if (!create) return undefined;
	const name = `turjuman-dev-${randomBytes(4).toString("hex")}`;
	writeFileSync(MARKER, name + "\n");
	return name;
}
