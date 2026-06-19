import type { aws_lambda as lambda } from "aws-cdk-lib";

/**
 * Per-function compute tuning shared by all Turjuman Lambda functions. Every
 * field is optional; the defaults reproduce the standard stack (arm64, 256 MB,
 * 15 s).
 */
export interface TurjumanFunctionTuning {
  /** CPU architecture (default "arm64"). Use "x86_64" to match a non-arm host
   * (e.g. LocalStack on x86). */
  architecture?: "arm64" | "x86_64";
  /** Memory in MB (default 256). */
  memorySize?: number;
  /** Timeout in seconds (default 15). */
  timeout?: number;
}

/** A toggleable function surface (the REST API or the webhook dispatcher): the
 * shared tuning plus an on/off switch. */
export interface TurjumanSurfaceOptions extends TurjumanFunctionTuning {
  /** Deploy this surface (default true). Set false to remove it. */
  enabled?: boolean;
}

/** The webhook dispatcher surface: a toggleable function plus the one knob that
 * is specific to its DynamoDB Streams event-source mapping. */
export interface TurjumanWebhookOptions extends TurjumanSurfaceOptions {
  /**
   * Where the stream poller begins reading (default "LATEST" — only changes made
   * after the mapping exists, so a redeploy never replays history). Set
   * "TRIM_HORIZON" to read from the start of the shard; this removes the
   * race where records written before the poller is actually live are missed,
   * which is useful for short-lived, freshly-deployed stacks (e.g. e2e).
   */
  streamStartingPosition?: "LATEST" | "TRIM_HORIZON";
}

/** DynamoDB single-table knobs. Defaults reproduce the on-demand, streamed,
 * retained table. */
export interface TurjumanTableOptions {
  /** Billing mode (default "PAY_PER_REQUEST"). "PROVISIONED" uses the capacity
   * fields below. */
  billingMode?: "PAY_PER_REQUEST" | "PROVISIONED";
  /** Provisioned read capacity, applied to the table and each GSI (default 25). */
  readCapacity?: number;
  /** Provisioned write capacity, applied to the table and each GSI (default 25). */
  writeCapacity?: number;
  /** Continuous backups / point-in-time recovery (default false). */
  pointInTimeRecovery?: boolean;
  /** Block table deletion at the DynamoDB API level (default false). */
  deletionProtection?: boolean;
}

/** Override the Lambda code for one or more functions. When omitted, each
 * function resolves the pre-bundled asset shipped by @turjuman/mcp-server /
 * @turjuman/api. */
export interface TurjumanCodeOverrides {
  mcp?: lambda.Code;
  api?: lambda.Code;
  webhook?: lambda.Code;
}

/** Run the functions inside an existing VPC. */
export interface TurjumanVpcOptions {
  subnetIds: string[];
  securityGroupIds?: string[];
}

/** Props for the reusable {@link Turjuman} construct. */
export interface TurjumanProps {
  /** Override the default npm-asset Lambda code (mainly for tests). */
  code?: TurjumanCodeOverrides;
  table?: TurjumanTableOptions;
  /** Tuning applied to every function unless a per-function block overrides it. */
  functionDefaults?: TurjumanFunctionTuning;
  /** The MCP server — always deployed (the core surface). */
  mcp?: TurjumanFunctionTuning;
  /** The REST API for the CLI/CI. Deployed unless `enabled: false`. */
  api?: TurjumanSurfaceOptions;
  /** The DynamoDB Streams → webhook dispatcher. Deployed unless `enabled: false`. */
  webhook?: TurjumanWebhookOptions;
  /** CORS allowed origins for the Function URLs (default ["*"]). */
  corsAllowOrigins?: string[];
  vpc?: TurjumanVpcOptions;
}

/** Props for the {@link TurjumanStack} wrapper. */
export interface TurjumanStackProps extends TurjumanProps {
  /** CloudFormation stack name (defaults to the construct id). */
  stackName?: string;
}
