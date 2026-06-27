import { defineConfig } from "vitest/config";

// Two modes share these specs (see helpers/env.ts):
//  - inprocess: the handlers run in this process against LocalStack DynamoDB —
//    no Lambda cold starts, so files can run in parallel with tight timeouts.
//  - deployed: real Lambda cold starts + the DynamoDB Streams -> Lambda poller,
//    both slow under LocalStack — hence the generous timeouts and a single,
//    non-parallel fork.
const inprocess = process.env.TURJUMAN_E2E_MODE === "inprocess";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
		globalSetup: ["./src/helpers/global-setup.ts"],
		testTimeout: inprocess ? 30_000 : 120_000,
		hookTimeout: inprocess ? 30_000 : 180_000,
		pool: "forks",
		poolOptions: { forks: { singleFork: !inprocess } },
		fileParallelism: inprocess,
	},
});
