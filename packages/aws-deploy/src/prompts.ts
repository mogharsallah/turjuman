import * as p from "@clack/prompts";

/** Abort cleanly if the user hit Ctrl-C at a clack prompt. Shared by deploy and
 * teardown so a cancel always exits with the same message and code. */
export function unwrap<T>(value: T | symbol): T {
	if (p.isCancel(value)) {
		p.cancel("Cancelled.");
		process.exit(0);
	}
	return value as T;
}
