#!/usr/bin/env node
// Poll LocalStack's health endpoint until the services the e2e suite needs are
// ready. Exits 0 once DynamoDB, Lambda and CloudFormation report available, or
// non-zero after the timeout.
//
//   node scripts/wait-for-localstack.mjs

const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
const HEALTH = `${ENDPOINT}/_localstack/health`;
const REQUIRED = ["dynamodb", "lambda", "cloudformation", "s3"];
const DEADLINE = Date.now() + 120_000;

const ready = (status) => status === "available" || status === "running";

while (Date.now() < DEADLINE) {
	try {
		const res = await fetch(HEALTH);
		if (res.ok) {
			const { services = {} } = await res.json();
			const pending = REQUIRED.filter((s) => !ready(services[s]));
			if (pending.length === 0) {
				console.log("LocalStack is ready:", REQUIRED.join(", "));
				process.exit(0);
			}
			console.log(`Waiting for LocalStack services: ${pending.join(", ")}`);
		}
	} catch {
		console.log("Waiting for LocalStack to accept connections...");
	}
	await new Promise((r) => setTimeout(r, 2000));
}

console.error("Timed out waiting for LocalStack to become ready.");
process.exit(1);
