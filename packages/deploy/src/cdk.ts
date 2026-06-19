import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  App,
  CfnOutput,
  Duration,
  LegacyStackSynthesizer,
  RemovalPolicy,
  Stack,
  aws_dynamodb as dynamodb,
  aws_lambda as lambda,
  aws_lambda_event_sources as eventsources,
  aws_s3 as s3,
} from "aws-cdk-lib";
import type { CfnResource } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { DEPLOY_FUNCTIONS } from "./functions.js";

/**
 * The Turjuman deploy stack, declared with AWS CDK and deployed with the CDK
 * programmatic toolkit (see toolkit.ts). The `LegacyStackSynthesizer` stages no
 * assets (function code is referenced directly from our own S3 bucket) and lets
 * the toolkit pass the small template inline to CloudFormation, so there is
 * **no CDK bootstrap** prerequisite, no template S3 upload, and no SAM macro —
 * the same path works on real AWS and on LocalStack. `synthTemplate` exposes the
 * synthesized template for tests.
 *
 * Logical ids of the stateful/primary resources (Table, the three functions and
 * their URLs) are pinned to the names a prior SAM deploy used, so deploying over
 * an existing stack is an in-place update — critically, the DynamoDB table is
 * NOT replaced (which would lose data). The table also carries
 * RemovalPolicy.RETAIN so it survives a stack delete.
 */

export interface SynthOptions {
  /** CloudFormation stack name (only affects the synthesized template id). */
  stackName: string;
  /** S3 location of each function's uploaded zip, keyed by logical id. */
  code: Record<string, { bucket: string; key: string }>;
  /** Lambda CPU architecture. Real AWS defaults to arm64; LocalStack runs match
   * the host to avoid emulation. */
  architecture?: "arm64" | "x86_64";
  memorySize?: number;
  /** Timeout in seconds. */
  timeout?: number;
  corsAllowOrigins?: string[];
  vpcSubnetIds?: string[];
  vpcSecurityGroupIds?: string[];
}

const pinLogicalId = (construct: Construct, id: string): void => {
  (construct.node.defaultChild as CfnResource).overrideLogicalId(id);
};

export class TurjumanStack extends Stack {
  constructor(scope: App, id: string, opts: SynthOptions) {
    super(scope, id, {
      // The legacy synthesizer stages nothing: function code is referenced
      // directly from S3 (not a CDK asset) and the small template is passed
      // inline to CloudFormation. So there is no template/asset S3 upload and no
      // `cdk bootstrap` — the toolkit deploys with the caller's credentials, and
      // the plain CloudFormation call works against both real AWS and LocalStack.
      synthesizer: new LegacyStackSynthesizer(),
    });

    const architecture =
      opts.architecture === "x86_64" ? lambda.Architecture.X86_64 : lambda.Architecture.ARM_64;
    const memorySize = opts.memorySize ?? 256;
    const timeout = Duration.seconds(opts.timeout ?? 15);
    const allowedOrigins =
      opts.corsAllowOrigins && opts.corsAllowOrigins.length > 0 ? opts.corsAllowOrigins : ["*"];

    // Single-table store. On-demand billing, streamed, retained on stack delete.
    const table = new dynamodb.Table(this, "Table", {
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    pinLogicalId(table, "Table");
    for (const name of ["GSI1", "GSI2", "GSI3"]) {
      table.addGlobalSecondaryIndex({
        indexName: name,
        partitionKey: { name: `${name}PK`, type: dynamodb.AttributeType.STRING },
        sortKey: { name: `${name}SK`, type: dynamodb.AttributeType.STRING },
        projectionType: dynamodb.ProjectionType.ALL,
      });
    }

    // One imported-by-name bucket per distinct deploy bucket (typically one).
    const buckets = new Map<string, s3.IBucket>();
    const codeFor = (logicalId: string): lambda.Code => {
      const loc = opts.code[logicalId];
      if (!loc) throw new Error(`No S3 code location provided for ${logicalId}.`);
      let bucket = buckets.get(loc.bucket);
      if (!bucket) {
        bucket = s3.Bucket.fromBucketName(this, `Bucket${buckets.size}`, loc.bucket);
        buckets.set(loc.bucket, bucket);
      }
      return lambda.Code.fromBucket(bucket, loc.key);
    };

    const makeFunction = (logicalId: string): lambda.Function => {
      const def = DEPLOY_FUNCTIONS.find((f) => f.logicalId === logicalId);
      if (!def) throw new Error(`Unknown function ${logicalId}.`);
      const fn = new lambda.Function(this, logicalId, {
        runtime: lambda.Runtime.NODEJS_20_X,
        architecture,
        handler: def.handler,
        code: codeFor(logicalId),
        description: def.description,
        memorySize,
        timeout,
        environment: { TURJUMAN_TABLE: table.tableName },
      });
      pinLogicalId(fn, logicalId);
      if (opts.vpcSubnetIds && opts.vpcSubnetIds.length > 0) {
        (fn.node.defaultChild as lambda.CfnFunction).vpcConfig = {
          subnetIds: opts.vpcSubnetIds,
          securityGroupIds: opts.vpcSecurityGroupIds ?? [],
        };
      }
      return fn;
    };

    const addUrl = (fn: lambda.Function, logicalId: string, allowedHeaders: string[]): lambda.FunctionUrl => {
      const url = fn.addFunctionUrl({
        authType: lambda.FunctionUrlAuthType.NONE, // Turjuman validates its own API keys.
        cors: {
          allowedOrigins,
          allowedMethods: [lambda.HttpMethod.GET, lambda.HttpMethod.POST],
          allowedHeaders,
        },
      });
      pinLogicalId(url, logicalId);
      return url;
    };

    // MCP server (Streamable HTTP, stateless) — read/write the table.
    const mcp = makeFunction("McpFunction");
    table.grantReadWriteData(mcp);
    const mcpUrl = addUrl(mcp, "McpFunctionUrl", [
      "authorization",
      "content-type",
      "mcp-protocol-version",
      "mcp-session-id",
    ]);

    // REST API for the developer CLI and CI — read/write the table.
    const api = makeFunction("ApiFunction");
    table.grantReadWriteData(api);
    const apiUrl = addUrl(api, "ApiFunctionUrl", ["authorization", "content-type"]);

    // Webhook dispatcher — reads the table and consumes its change stream.
    const webhook = makeFunction("WebhookFunction");
    table.grantReadData(webhook);
    table.grantStreamRead(webhook);
    webhook.addEventSource(
      new eventsources.DynamoEventSource(table, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 10,
        retryAttempts: 2,
        bisectBatchOnError: true,
      }),
    );

    new CfnOutput(this, "McpUrl", { value: mcpUrl.url });
    new CfnOutput(this, "ApiUrl", { value: apiUrl.url });
    new CfnOutput(this, "TableName", { value: table.tableName });
  }
}

/**
 * Synthesize the Turjuman stack to a plain CloudFormation template object, for
 * tests and inspection (the real deploy goes through the CDK toolkit, which
 * synthesizes the same stack internally). Writes to a throwaway temp dir that is
 * removed before returning, so this is a pure function from the caller's view.
 */
export function synthTemplate(opts: SynthOptions): Record<string, unknown> {
  const outdir = mkdtempSync(join(tmpdir(), "turjuman-cdk-"));
  try {
    const app = new App({ outdir, analyticsReporting: false });
    const stack = new TurjumanStack(app, opts.stackName, opts);
    const assembly = app.synth();
    return assembly.getStackArtifact(stack.artifactId).template as Record<string, unknown>;
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
}
