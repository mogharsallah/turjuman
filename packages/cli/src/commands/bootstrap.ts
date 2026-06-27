import type { BootstrapResult } from "@turjuman/schema";
import type { Command } from "commander";
import { saveAuth } from "../config.js";
import type { CliDeps } from "../deps.js";
import { usageError } from "../errors.js";
import type { OutputSink } from "../output.js";

export interface BootstrapOpts {
	url: string;
	email: string;
	name: string;
}

/**
 * An unauthenticated POST to `/v1/bootstrap`. Bootstrap runs before any API key
 * exists, so it cannot go through the bearer-authenticated {@link ApiClient};
 * this tiny helper is injected so the command is testable with a fake.
 */
export type BootstrapPost = (
	url: string,
	body: { email: string; name: string },
) => Promise<{ status: number; json: unknown }>;

const realPost: BootstrapPost = async (url, body) => {
	const endpoint = `${url.replace(/\/+$/, "")}/v1/bootstrap`;
	let res: Response;
	try {
		res = await fetch(endpoint, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	} catch (err) {
		// Mirror ApiClient.request: a connection failure becomes a friendly,
		// actionable message instead of a raw `TypeError: fetch failed`.
		throw usageError(
			`Cannot reach ${endpoint}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	let json: unknown;
	try {
		json = await res.json();
	} catch {
		json = undefined;
	}
	return { status: res.status, json };
};

/**
 * Create the first OWNER on a fresh deployment and persist its one-time API key.
 * Pure + injectable (`post`/`save`) so it runs under test with no network or fs.
 */
export async function runBootstrap(
	opts: BootstrapOpts,
	out: OutputSink,
	post: BootstrapPost = realPost,
	save: typeof saveAuth = saveAuth,
): Promise<BootstrapResult> {
	const { status, json } = await post(opts.url, {
		email: opts.email,
		name: opts.name,
	});

	if (status === 409) {
		throw usageError(
			"An owner already exists for this deployment. `bootstrap` only creates " +
				"the first owner — ask an existing owner to mint you a key, then run " +
				'"turjuman login".',
		);
	}
	if (status !== 201) {
		const msg =
			(json as { error?: string } | undefined)?.error ??
			`Bootstrap failed (HTTP ${status}).`;
		throw usageError(msg);
	}

	const result = json as BootstrapResult | undefined;
	if (!result || typeof result.secret !== "string") {
		// A 201 with an empty/non-JSON body (e.g. a proxy in front of the Function
		// URL). The owner may have been created server-side, so don't pretend success.
		throw usageError(
			"Bootstrap returned HTTP 201 with an unexpected body. The owner may have " +
				"been created — verify with an existing key before retrying.",
		);
	}

	// Print the one-time key FIRST. It is never recoverable, so it must reach the
	// operator even if persisting credentials below fails (read-only home, full
	// disk): a save failure must not destroy the only copy of the key.
	out.line(`Created owner ${result.user.email}.`);
	out.line(`API key: ${result.secret}`);
	out.note(
		"This key is shown once — store it now; it cannot be retrieved again.",
	);

	let file: string | undefined;
	try {
		file = save({ url: opts.url, key: result.secret });
		out.line(`Saved credentials to ${file}.`);
	} catch (err) {
		out.note(
			`Could not save credentials (${err instanceof Error ? err.message : String(err)}). ` +
				`Run \`turjuman login --url ${opts.url} --key <the key above>\` once ~/.turjuman is writable.`,
		);
	}

	out.result({
		command: "bootstrap",
		url: opts.url,
		user: result.user,
		key: result.secret,
		file,
	});
	return result;
}

export function registerBootstrap(program: Command, deps: CliDeps): void {
	program
		.command("bootstrap")
		.description(
			"Create the first owner on a fresh Turjuman deployment and save its API key.",
		)
		.requiredOption("--url <url>", "Turjuman REST API base URL")
		.requiredOption("--email <email>", "Owner email address")
		.requiredOption("--name <name>", "Owner display name")
		.action(async (opts: BootstrapOpts) => {
			await runBootstrap(opts, deps.out);
		});
}
