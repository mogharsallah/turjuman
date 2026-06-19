import { describe, expect, it } from "vitest";
import { synthTemplate } from "./cdk.js";

/**
 * The CDK stack is now the single source of truth for the deploy topology, so
 * this asserts the synthesized template in absolute terms — most importantly the
 * data-critical DynamoDB table (its key schema, GSIs, stream, billing) and its
 * RETAIN policy, plus the functions, URLs and stream wiring. The toolkit deploys
 * this same stack; the real LocalStack deploy is exercised by the e2e tier.
 */

const CODE = {
  McpFunction: { bucket: "turjuman-deploy-us-east-1-test01", key: "mcp.zip" },
  ApiFunction: { bucket: "turjuman-deploy-us-east-1-test01", key: "api.zip" },
  WebhookFunction: { bucket: "turjuman-deploy-us-east-1-test01", key: "wh.zip" },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Cfn = Record<string, any>;

const synth = synthTemplate({ stackName: "turjuman", code: CODE }) as Cfn;

const resourcesOfType = (type: string): [string, Cfn][] =>
  Object.entries(synth.Resources as Record<string, Cfn>).filter(([, r]) => r.Type === type);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sortByName = (arr: any[], key: string) =>
  [...arr].sort((a, b) => String(a[key]).localeCompare(String(b[key])));

describe("CDK synth", () => {
  it("is plain CloudFormation deployable without a bootstrapped environment", () => {
    expect(Object.keys(synth.Parameters ?? {})).toEqual([]);
    expect(Object.keys(synth.Rules ?? {})).toEqual([]);
  });

  it("declares the single-table store with the expected schema, retained", () => {
    const tables = resourcesOfType("AWS::DynamoDB::Table");
    expect(tables).toHaveLength(1);
    const [logicalId, table] = tables[0]!;
    // A stable logical id keeps a redeploy an in-place update (no replacement).
    expect(logicalId).toBe("Table");

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

  it("declares the three Lambda functions with stable ids and the table env var", () => {
    for (const [logicalId, handler, code] of [
      ["McpFunction", "handler.handler", CODE.McpFunction],
      ["ApiFunction", "handler.handler", CODE.ApiFunction],
      ["WebhookFunction", "webhook.handler", CODE.WebhookFunction],
    ] as const) {
      const fn = synth.Resources[logicalId];
      expect(fn?.Type).toBe("AWS::Lambda::Function");
      expect(fn.Properties.Handler).toBe(handler);
      expect(fn.Properties.Runtime).toBe("nodejs20.x");
      expect(fn.Properties.Code).toEqual({ S3Bucket: code.bucket, S3Key: code.key });
      expect(fn.Properties.Environment.Variables.TURJUMAN_TABLE).toEqual({ Ref: "Table" });
    }
  });

  it("exposes both Function URLs without platform auth (Turjuman validates its own keys)", () => {
    for (const id of ["McpFunctionUrl", "ApiFunctionUrl"]) {
      const url = synth.Resources[id];
      expect(url?.Type).toBe("AWS::Lambda::Url");
      expect(url.Properties.AuthType).toBe("NONE");
    }
  });

  it("wires the webhook function to the table's change stream", () => {
    const mappings = resourcesOfType("AWS::Lambda::EventSourceMapping");
    expect(mappings).toHaveLength(1);
    const props = mappings[0]![1].Properties;
    expect(props.EventSourceArn).toEqual({ "Fn::GetAtt": ["Table", "StreamArn"] });
    expect(props.FunctionName).toEqual({ Ref: "WebhookFunction" });
    expect(props.StartingPosition).toBe("LATEST");
    expect(props.BatchSize).toBe(10);
  });

  it("outputs the same three values the deployer reads back", () => {
    expect(Object.keys(synth.Outputs).sort()).toEqual(["ApiUrl", "McpUrl", "TableName"]);
    expect(synth.Outputs.TableName.Value).toEqual({ Ref: "Table" });
  });
});
