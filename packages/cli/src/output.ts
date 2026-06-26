/**
 * Output abstraction so every command can render either human text (the default)
 * or a single machine-readable JSON document (`--json`, for CI and agents).
 *
 * Contract:
 *  - `line()` is human-facing progress/result. TextSink writes it to stdout;
 *    JsonSink drops it (stdout must stay a single parseable document).
 *  - `note()` is a diagnostic. It always goes to stderr, so it never pollutes
 *    the JSON document on stdout.
 *  - `result()` records the command's machine result. JsonSink emits it on
 *    `flush()`; TextSink ignores it.
 */
export interface OutputSink {
	line(text: string): void;
	note(text: string): void;
	result(payload: unknown): void;
	flush(): void;
}

class TextSink implements OutputSink {
	line(text: string): void {
		process.stdout.write(text + "\n");
	}
	note(text: string): void {
		process.stderr.write(text + "\n");
	}
	result(): void {
		/* text mode renders via line(); the structured result is not printed */
	}
	flush(): void {
		/* nothing buffered */
	}
}

class JsonSink implements OutputSink {
	private payload: unknown = {};
	line(): void {
		/* suppressed: stdout is reserved for the JSON document */
	}
	note(text: string): void {
		process.stderr.write(text + "\n");
	}
	result(payload: unknown): void {
		this.payload = payload;
	}
	flush(): void {
		process.stdout.write(JSON.stringify(this.payload, null, 2) + "\n");
	}
}

export function createSink(json: boolean): OutputSink {
	return json ? new JsonSink() : new TextSink();
}

/** Whether `--json` was requested. Read from argv so the sink exists before
 * commander parses (the flag is also declared on the program for help/stripping). */
export function wantsJson(argv: readonly string[] = process.argv): boolean {
	return argv.includes("--json");
}
