/** Extra, machine-readable detail attached to a failure. The API returns a
 * typed `code` and a per-request `requestId` (echoed in the X-Request-Id
 * header) — both are surfaced so a failure can be tied to a server-side log. */
export interface ErrorDetails {
	code?: string;
	requestId?: string;
}

/**
 * A CLI-level error that carries the process exit code to use when it reaches
 * the top-level handler. Exit-code policy (also documented in the CLI docs):
 *   0  success (no QA error findings)
 *   1  QA error findings present (set by the check/push --check wrappers)
 *   2  usage error (bad flags, missing config, not logged in)
 *   3  API / network error
 */
export class CliError extends Error {
	readonly code?: string;
	readonly requestId?: string;
	constructor(
		message: string,
		readonly exitCode: number = 1,
		details: ErrorDetails = {},
	) {
		super(message);
		this.name = "CliError";
		this.code = details.code;
		this.requestId = details.requestId;
	}
}

/** A misconfiguration / bad-usage error (missing config, not logged in, …). */
export function usageError(message: string): CliError {
	return new CliError(message, 2);
}

/** An error talking to the API (non-OK response or transport failure). */
export function apiError(
	message: string,
	details: ErrorDetails = {},
): CliError {
	return new CliError(message, 3, details);
}
