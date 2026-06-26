import { ApiClient } from "./client.js";
import {
	loadAuth,
	type ProjectConfig,
	loadConfig as realLoadConfig,
} from "./config.js";
import type { OutputSink } from "./output.js";

/**
 * Everything a command needs from its environment, injected so the whole program
 * can be driven with fakes in tests. Defaults wire the real implementations.
 */
export interface CliDeps {
	out: OutputSink;
	/** Build an authenticated API client (reads ~/.turjuman/auth.json by default). */
	clientFactory: () => ApiClient;
	/** Load turjuman.config.json from the current directory. */
	loadConfig: (cwd?: string) => ProjectConfig;
}

/** Build the real client from saved credentials. */
export function defaultClientFactory(): ApiClient {
	const auth = loadAuth();
	return new ApiClient(auth.url, auth.key);
}

export { realLoadConfig };
