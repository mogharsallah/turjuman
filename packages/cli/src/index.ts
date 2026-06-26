#!/usr/bin/env node
import { CliError } from "./errors.js";
import { createSink, wantsJson } from "./output.js";
import { buildDefaultProgram } from "./program.js";

// Exit quietly when piped into a reader that closes early (e.g. `… | head`).
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
	if (err.code === "EPIPE") process.exit(0);
	throw err;
});

const { program, flush } = buildDefaultProgram(process.argv);

program
	.parseAsync(process.argv)
	.then(() => {
		flush();
	})
	.catch((err: unknown) => {
		const message = err instanceof Error ? err.message : String(err);
		const exitCode = err instanceof CliError ? err.exitCode : 1;
		const cliErr = err instanceof CliError ? err : undefined;
		// Surface structured failures too, so --json consumers always get a document.
		const out = createSink(wantsJson(process.argv));
		out.note(`Error: ${message}`);
		out.result({
			error: message,
			...(cliErr?.code ? { code: cliErr.code } : {}),
			...(cliErr?.requestId ? { requestId: cliErr.requestId } : {}),
		});
		out.flush();
		process.exitCode = exitCode;
	});
