import { createRequire } from "node:module";
import { dirname } from "node:path";
import {
	Duration,
	aws_dynamodb as dynamodb,
	aws_lambda_event_sources as eventsources,
	aws_lambda as lambda,
	RemovalPolicy,
	aws_s3 as s3,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import type { TurjumanFunctionTuning, TurjumanProps } from "./props.js";

const require = createRequire(import.meta.url);
/** Resolve the directory holding a package asset file — the Code.fromAsset root. */
const assetDir = (spec: string): string => dirname(require.resolve(spec));

interface FunctionDef {
	/** Construct id → drives a stable (idiomatic) CloudFormation logical id. */
	id: string;
	/** npm subpath to the pre-bundled asset, resolved for the default Code. */
	assetSpec: string;
	/** Lambda handler `<file>.<exportedFn>`. */
	handler: string;
	description: string;
}

const MCP: FunctionDef = {
	id: "McpFunction",
	assetSpec: "@turjuman/mcp-server/lambda/handler.mjs",
	handler: "handler.handler",
	description: "Turjuman MCP server",
};
const API: FunctionDef = {
	id: "ApiFunction",
	assetSpec: "@turjuman/api/lambda/handler.mjs",
	handler: "handler.handler",
	description: "Turjuman REST API",
};
const WEBHOOK: FunctionDef = {
	id: "WebhookFunction",
	assetSpec: "@turjuman/api/lambda-webhook/webhook.mjs",
	handler: "webhook.handler",
	description: "Turjuman webhook dispatcher (DynamoDB Streams)",
};

/**
 * The Turjuman serverless backend as one composable CDK construct: the retained
 * single-table DynamoDB store (PK/SK + GSI1/2/3 + Streams) and up to three Lambda
 * Function URLs — the always-on MCP server, the optional REST API, and the
 * optional DynamoDB Streams → webhook dispatcher. Drop it into any stack, or use
 * the {@link TurjumanStack} wrapper for a standalone deploy.
 *
 * Resource identity is idiomatic CDK (hashed logical ids) EXCEPT the table: its
 * construct id is deliberately fixed and it carries RemovalPolicy.RETAIN, so no
 * refactor can make CloudFormation replace (and thus wipe) the data. The table's
 * Stream stays on even when the webhook surface is disabled, so re-enabling it
 * later never replaces the table.
 */
export class Turjuman extends Construct {
	/** The single-table store (PK/SK + GSI1/2/3), streamed and retained. */
	readonly table: dynamodb.Table;
	/** The always-on MCP server function and its Function URL. */
	readonly mcpFunction: lambda.Function;
	readonly mcpUrl: lambda.FunctionUrl;
	/** The REST API function and URL — undefined when `api.enabled === false`. */
	readonly apiFunction?: lambda.Function;
	readonly apiUrl?: lambda.FunctionUrl;
	/** The webhook dispatcher — undefined when `webhook.enabled === false`. */
	readonly webhookFunction?: lambda.Function;

	constructor(scope: Construct, id: string, props: TurjumanProps = {}) {
		super(scope, id);

		const table = this.createTable(props);
		this.table = table;

		const allowedOrigins =
			props.corsAllowOrigins && props.corsAllowOrigins.length > 0
				? props.corsAllowOrigins
				: ["*"];

		const tuning = (
			specific?: TurjumanFunctionTuning,
		): TurjumanFunctionTuning => ({
			...props.functionDefaults,
			...specific,
		});

		const makeFunction = (
			def: FunctionDef,
			code: lambda.Code,
			t: TurjumanFunctionTuning,
		): lambda.Function => {
			const fn = new lambda.Function(this, def.id, {
				runtime: lambda.Runtime.NODEJS_24_X,
				architecture:
					t.architecture === "x86_64"
						? lambda.Architecture.X86_64
						: lambda.Architecture.ARM_64,
				handler: def.handler,
				code,
				description: def.description,
				memorySize: t.memorySize ?? 256,
				timeout: Duration.seconds(t.timeout ?? 15),
				environment: { TURJUMAN_TABLE: table.tableName },
			});
			if (props.vpc) {
				(fn.node.defaultChild as lambda.CfnFunction).vpcConfig = {
					subnetIds: props.vpc.subnetIds,
					securityGroupIds: props.vpc.securityGroupIds ?? [],
				};
			}
			return fn;
		};

		// Code precedence: explicit `code` override → dev `hotReload` dir (LocalStack
		// magic bucket) → the default pre-bundled npm asset.
		const codeFor = (
			def: FunctionDef,
			override?: lambda.Code,
			hotReloadDir?: string,
		): lambda.Code => {
			if (override) return override;
			if (hotReloadDir) {
				const bucket = s3.Bucket.fromBucketName(
					this,
					`${def.id}HotReload`,
					"hot-reload",
				);
				return lambda.Code.fromBucket(bucket, hotReloadDir);
			}
			return lambda.Code.fromAsset(assetDir(def.assetSpec));
		};

		const addUrl = (
			fn: lambda.Function,
			allowedHeaders: string[],
		): lambda.FunctionUrl =>
			fn.addFunctionUrl({
				authType: lambda.FunctionUrlAuthType.NONE, // Turjuman validates its own API keys.
				cors: {
					allowedOrigins,
					allowedMethods: [lambda.HttpMethod.GET, lambda.HttpMethod.POST],
					allowedHeaders,
				},
			});

		// MCP server — always deployed (the core surface).
		const mcp = makeFunction(
			MCP,
			codeFor(MCP, props.code?.mcp, props.hotReload?.mcp),
			tuning(props.mcp),
		);
		table.grantReadWriteData(mcp);
		this.mcpFunction = mcp;
		this.mcpUrl = addUrl(mcp, [
			"authorization",
			"content-type",
			"mcp-protocol-version",
			"mcp-session-id",
		]);

		// REST API for the developer CLI and CI — deployed unless explicitly disabled.
		if (props.api?.enabled !== false) {
			const api = makeFunction(
				API,
				codeFor(API, props.code?.api, props.hotReload?.api),
				tuning(props.api),
			);
			table.grantReadWriteData(api);
			this.apiFunction = api;
			this.apiUrl = addUrl(api, ["authorization", "content-type"]);
		}

		// Webhook dispatcher — deployed unless explicitly disabled. The table keeps
		// its Stream either way (see createTable), so toggling this never replaces it.
		if (props.webhook?.enabled !== false) {
			const webhook = makeFunction(
				WEBHOOK,
				codeFor(WEBHOOK, props.code?.webhook, props.hotReload?.webhook),
				tuning(props.webhook),
			);
			table.grantReadData(webhook);
			table.grantStreamRead(webhook);
			webhook.addEventSource(
				new eventsources.DynamoEventSource(table, {
					startingPosition:
						props.webhook?.streamStartingPosition === "TRIM_HORIZON"
							? lambda.StartingPosition.TRIM_HORIZON
							: lambda.StartingPosition.LATEST,
					batchSize: 10,
					retryAttempts: 2,
					bisectBatchOnError: true,
				}),
			);
			this.webhookFunction = webhook;
		}
	}

	private createTable(props: TurjumanProps): dynamodb.Table {
		const opts = props.table ?? {};
		const provisioned = opts.billingMode === "PROVISIONED";
		const readCapacity = opts.readCapacity ?? 25;
		const writeCapacity = opts.writeCapacity ?? 25;

		// The construct id "Table" is deliberately fixed: with RemovalPolicy.RETAIN
		// it pins the table's identity so a refactor can never make CloudFormation
		// replace (and thus wipe) the data.
		const table = new dynamodb.Table(this, "Table", {
			partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
			sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
			billingMode: provisioned
				? dynamodb.BillingMode.PROVISIONED
				: dynamodb.BillingMode.PAY_PER_REQUEST,
			...(provisioned ? { readCapacity, writeCapacity } : {}),
			// The Stream stays on regardless of the webhook surface so re-enabling
			// webhooks later never replaces the table.
			stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
			...(opts.pointInTimeRecovery
				? {
						pointInTimeRecoverySpecification: {
							pointInTimeRecoveryEnabled: true,
						},
					}
				: {}),
			...(opts.deletionProtection ? { deletionProtection: true } : {}),
			removalPolicy: RemovalPolicy.RETAIN,
		});

		for (const name of ["GSI1", "GSI2", "GSI3"]) {
			table.addGlobalSecondaryIndex({
				indexName: name,
				partitionKey: {
					name: `${name}PK`,
					type: dynamodb.AttributeType.STRING,
				},
				sortKey: { name: `${name}SK`, type: dynamodb.AttributeType.STRING },
				projectionType: dynamodb.ProjectionType.ALL,
				...(provisioned ? { readCapacity, writeCapacity } : {}),
			});
		}
		return table;
	}
}
