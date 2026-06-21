import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aws_lambda as lambda } from "aws-cdk-lib";
import { describe, expect, it } from "vitest";
import { synthTemplate } from "./synth.js";

/**
 * The construct is the single source of truth for the deploy topology, so this
 * asserts the synthesized template in absolute terms — most importantly the
 * data-critical DynamoDB table (key schema, GSIs, stream, billing), its RETAIN
 * policy, and a stable logical id — plus the functions, URLs, stream wiring and
 * the api/webhook toggles. The toolkit deploys this same stack; the real
 * LocalStack deploy is exercised by the e2e tier.
 *
 * A throwaway on-disk fixture stands in for the published Lambda assets so synth
 * is hermetic (no built @turjuman/mcp-server / @turjuman/api assets required).
 */
const fixture = mkdtempSync(join(tmpdir(), "turjuman-asset-"));
writeFileSync(join(fixture, "handler.mjs"), "export const handler = async () => ({});\n");
writeFileSync(join(fixture, "package.json"), '{"type":"module"}\n');
// A Code.fromAsset instance binds to the first stack it is used in, so build a
// fresh set per synth (each test synthesizes its own throwaway stack).
const freshCode = () => ({
  mcp: lambda.Code.fromAsset(fixture),
  api: lambda.Code.fromAsset(fixture),
  webhook: lambda.Code.fromAsset(fixture),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Cfn = Record<string, any>;

const synthWith = (props: Record<string, unknown> = {}): Cfn =>
  synthTemplate({ stackName: "turjuman", code: freshCode(), ...props }) as Cfn;

const synth = synthWith();

const resourcesOfType = (t: Cfn, type: string): [string, Cfn][] =>
  Object.entries(t.Resources as Record<string, Cfn>).filter(([, r]) => r.Type === type);

const fnByDescription = (t: Cfn, description: string): Cfn | undefined =>
  resourcesOfType(t, "AWS::Lambda::Function").find(
    ([, r]) => r.Properties.Description === description,
  )?.[1];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sortByName = (arr: any[], key: string) =>
  [...arr].sort((a, b) => String(a[key]).localeCompare(String(b[key])));

describe("CDK synth", () => {
  it("uses the standard CDK bootstrap (BootstrapVersion param + version-check rule)", () => {
    // The default synthesizer publishes assets through the bootstrapped staging
    // bucket, so — unlike the old legacy-synthesizer stack — the template now
    // carries a BootstrapVersion parameter and the CheckBootstrapVersion rule.
    expect(synth.Parameters?.BootstrapVersion).toBeDefined();
    expect(synth.Rules?.CheckBootstrapVersion).toBeDefined();
  });

  it("declares the single-table store with the expected schema, retained", () => {
    const tables = resourcesOfType(synth, "AWS::DynamoDB::Table");
    expect(tables).toHaveLength(1);
    const [logicalId, table] = tables[0]!;
    // Idiomatic (hashed) logical id, but deliberately stable: locking the table's
    // construct id keeps a redeploy an in-place update (no replacement/data loss).
    expect(logicalId).toMatch(/^TurjumanTable[0-9A-F]{8}$/);
    expect(resourcesOfType(synthWith(), "AWS::DynamoDB::Table")[0]![0]).toBe(logicalId);

    const p = table.Properties;
    expect(p.BillingMode).toBe("PAY_PER_REQUEST");
    expect(p.KeySchema).toEqual([
      { AttributeName: "PK", KeyType: "HASH" },
      { AttributeName: "SK", KeyType: "RANGE" },
    ]);
    expect(p.StreamSpecification).toEqual({ StreamViewType: "NEW_AND_OLD_IMAGES" });

    expect(sortByName(p.AttributeDefinitions, "AttributeName")).toEqual([
      { AttributeName: "GSI1PK", AttributeType: "S" },
      { AttributeName: "GSI1SK", AttributeType: "S" },
      { AttributeName: "GSI2PK", AttributeType: "S" },
      { AttributeName: "GSI2SK", AttributeType: "S" },
      { AttributeName: "GSI3PK", AttributeType: "S" },
      { AttributeName: "GSI3SK", AttributeType: "S" },
      { AttributeName: "PK", AttributeType: "S" },
      { AttributeName: "SK", AttributeType: "S" },
    ]);
    expect(
      sortByName(p.GlobalSecondaryIndexes, "IndexName").map((g: Cfn) => ({
        IndexName: g.IndexName,
        KeySchema: g.KeySchema,
        Projection: g.Projection,
      })),
    ).toEqual(
      ["GSI1", "GSI2", "GSI3"].map((n) => ({
        IndexName: n,
        KeySchema: [
          { AttributeName: `${n}PK`, KeyType: "HASH" },
          { AttributeName: `${n}SK`, KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
      })),
    );

    // Retained on stack delete so an accidental teardown can't lose data.
    expect(table.DeletionPolicy).toBe("Retain");
    expect(table.UpdateReplacePolicy).toBe("Retain");
  });

  it("declares the three Lambda functions with the table env var and handlers", () => {
    const tableId = resourcesOfType(synth, "AWS::DynamoDB::Table")[0]![0];
    for (const [description, handler] of [
      ["Turjuman MCP server", "handler.handler"],
      ["Turjuman REST API", "handler.handler"],
      ["Turjuman webhook dispatcher (DynamoDB Streams)", "webhook.handler"],
    ] as const) {
      const fn = fnByDescription(synth, description);
      expect(fn, description).toBeDefined();
      expect(fn!.Properties.Handler).toBe(handler);
      expect(fn!.Properties.Runtime).toBe("nodejs24.x");
      expect(fn!.Properties.Environment.Variables.TURJUMAN_TABLE).toEqual({ Ref: tableId });
    }
  });

  it("exposes both Function URLs without platform auth (Turjuman validates its own keys)", () => {
    const urls = resourcesOfType(synth, "AWS::Lambda::Url");
    expect(urls).toHaveLength(2);
    for (const [, url] of urls) expect(url.Properties.AuthType).toBe("NONE");
  });

  it("wires the webhook function to the table's change stream", () => {
    const tableId = resourcesOfType(synth, "AWS::DynamoDB::Table")[0]![0];
    const mappings = resourcesOfType(synth, "AWS::Lambda::EventSourceMapping");
    expect(mappings).toHaveLength(1);
    const props = mappings[0]![1].Properties;
    expect(props.EventSourceArn).toEqual({ "Fn::GetAtt": [tableId, "StreamArn"] });
    expect(props.StartingPosition).toBe("LATEST");
    expect(props.BatchSize).toBe(10);
  });

  it("reads the stream from the horizon when streamStartingPosition is TRIM_HORIZON", () => {
    const t = synthWith({ webhook: { streamStartingPosition: "TRIM_HORIZON" } });
    const mapping = resourcesOfType(t, "AWS::Lambda::EventSourceMapping")[0]![1];
    expect(mapping.Properties.StartingPosition).toBe("TRIM_HORIZON");
  });

  it("outputs the three values the deployer reads back", () => {
    expect(Object.keys(synth.Outputs).sort()).toEqual(["ApiUrl", "McpUrl", "TableName"]);
  });

  it("drops the webhook function and its event source when webhook.enabled is false", () => {
    const t = synthWith({ webhook: { enabled: false } });
    expect(fnByDescription(t, "Turjuman webhook dispatcher (DynamoDB Streams)")).toBeUndefined();
    expect(resourcesOfType(t, "AWS::Lambda::EventSourceMapping")).toHaveLength(0);
    // The table keeps its Stream so re-enabling webhooks later never replaces it.
    const table = resourcesOfType(t, "AWS::DynamoDB::Table")[0]![1];
    expect(table.Properties.StreamSpecification).toEqual({ StreamViewType: "NEW_AND_OLD_IMAGES" });
  });

  it("drops the api function, its url and output when api.enabled is false", () => {
    const t = synthWith({ api: { enabled: false } });
    expect(fnByDescription(t, "Turjuman REST API")).toBeUndefined();
    // Only the MCP url remains.
    expect(resourcesOfType(t, "AWS::Lambda::Url")).toHaveLength(1);
    expect(Object.keys(t.Outputs).sort()).toEqual(["McpUrl", "TableName"]);
  });

  it("switches the table (and its GSIs) to provisioned throughput on request", () => {
    const t = synthWith({ table: { billingMode: "PROVISIONED", readCapacity: 5, writeCapacity: 7 } });
    const table = resourcesOfType(t, "AWS::DynamoDB::Table")[0]![1];
    // CDK omits BillingMode for provisioned tables (PROVISIONED is the CFN
    // default) and emits ProvisionedThroughput instead.
    expect(table.Properties.BillingMode).toBeUndefined();
    expect(table.Properties.ProvisionedThroughput).toEqual({
      ReadCapacityUnits: 5,
      WriteCapacityUnits: 7,
    });
    for (const gsi of table.Properties.GlobalSecondaryIndexes) {
      expect(gsi.ProvisionedThroughput).toEqual({ ReadCapacityUnits: 5, WriteCapacityUnits: 7 });
    }
  });
});
