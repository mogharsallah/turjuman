import { defineConfig } from "vitest/config";

// The deployed e2e exercises real Lambda cold starts and the DynamoDB
// Streams -> Lambda poller, both of which are slow under LocalStack — hence the
// generous timeouts and a single, non-parallel fork.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
  },
});
