#!/usr/bin/env node
// Stream the deployed Lambdas' CloudWatch logs back to the terminal so `pnpm run dev`
// shows request lines as they happen. The old host-process loop printed them inline;
// the LocalStack Lambda loop sends them to CloudWatch instead, so we poll them back
// and prefix each line with its function ([mcp]/[api]/[webhook]). Set DEV_LOGS=0 to
// disable. Best-effort: never throws into the dev loop.
import {
	CloudWatchLogsClient,
	DescribeLogGroupsCommand,
	FilterLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";

// Match the old `concurrently -c blue,green` prefixes; magenta for the webhook.
const COLORS = {
	mcp: "\x1b[34m",
	api: "\x1b[32m",
	webhook: "\x1b[35m",
	lambda: "\x1b[90m",
};
const RESET = "\x1b[0m";

// Noise next to our structured JSON: the Lambda runtime's framing lines and the
// AWS SDK Node-version support warning (NodeVersionSupportWarning), if any.
const RUNTIME_NOISE =
	/^(START|END|REPORT|INIT_START|INIT_REPORT|EXTENSION)\b|NodeVersionSupportWarning/;

// LocalStack/Lambda prefix each line with "<ISO ts>\t<reqId>\t<LEVEL>\t<message>";
// strip it down to the message so our JSON reads cleanly behind the [label] prefix.
function unwrap(message) {
	const m = message.match(
		/^\S+\t\S+\t(?:INFO|WARN|ERROR|DEBUG|TRACE|FATAL)\t([\s\S]*)$/,
	);
	return (m ? m[1] : message).replace(/\s+$/, "");
}

/** Short label from a CDK-generated log group name, via the function's logical id. */
function labelFor(groupName) {
	if (/McpFunction/i.test(groupName)) return "mcp";
	if (/WebhookFunction/i.test(groupName)) return "webhook";
	if (/ApiFunction/i.test(groupName)) return "api";
	return "lambda";
}

/**
 * Poll the `${stackName}-*` Lambda log groups and print new events. Resolves once
 * polling is armed (after the first tick); the interval keeps running for the life
 * of the process.
 */
export async function streamLogs({
	stackName,
	endpoint,
	region,
	pollMs = 1000,
} = {}) {
	if (process.env.DEV_LOGS === "0") return;
	const client = new CloudWatchLogsClient({
		endpoint,
		region,
		credentials: { accessKeyId: "test", secretAccessKey: "test" },
	});
	const prefix = `/aws/lambda/${stackName}-`;
	const since = new Map(); // per-group cursor: last event timestamp printed + 1
	const start = Date.now(); // ignore anything before the dev loop started

	const tick = async () => {
		let groups = [];
		try {
			const res = await client.send(
				new DescribeLogGroupsCommand({ logGroupNamePrefix: prefix }),
			);
			groups = (res.logGroups ?? [])
				.map((g) => g.logGroupName)
				.filter((n) => n && n.startsWith(prefix));
		} catch {
			return; // LocalStack not ready / transient — retry next tick.
		}
		await Promise.all(
			groups.map(async (group) => {
				const label = labelFor(group);
				const color = COLORS[label] ?? COLORS.lambda;
				try {
					const res = await client.send(
						new FilterLogEventsCommand({
							logGroupName: group,
							startTime: since.get(group) ?? start,
						}),
					);
					for (const ev of res.events ?? []) {
						// +1ms so the next poll's startTime doesn't re-emit this same event.
						since.set(
							group,
							Math.max(since.get(group) ?? 0, (ev.timestamp ?? 0) + 1),
						);
						const line = unwrap(ev.message ?? "");
						if (line && !RUNTIME_NOISE.test(line))
							console.log(`${color}[${label}]${RESET} ${line}`);
					}
				} catch {
					// Group may not exist until the function's first invoke — ignore, retry.
				}
			}),
		);
	};

	console.log(
		"Streaming Lambda logs ([mcp]/[api]/[webhook]) — set DEV_LOGS=0 to disable.\n",
	);
	await tick().catch(() => {});
	const timer = setInterval(() => void tick().catch(() => {}), pollMs);
	timer.unref?.(); // don't let the poller alone keep the process alive
}
