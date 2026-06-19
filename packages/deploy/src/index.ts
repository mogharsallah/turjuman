import { S3Client } from "@aws-sdk/client-s3";
import * as p from "@clack/prompts";
import { saveAuth } from "@turjuman/cli/auth";
import { bootstrapFirstOwner } from "./bootstrap.js";
import { type Artifact, bundleFunction } from "./bundle.js";
import { type DeployConfig, loadDeployConfig, saveDeployConfig } from "./config.js";
import { DEPLOY_FUNCTIONS, findRepoRoot } from "./functions.js";
import { unwrap } from "./prompts.js";
import { ensureDeployBucket, uploadArtifact } from "./s3.js";
import { deployStack } from "./toolkit.js";

const splitList = (s: string): string[] =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

/** Gather deploy settings interactively, seeded by any saved config. */
async function gatherConfig(existing: DeployConfig | undefined): Promise<DeployConfig> {
  const envRegion = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;

  const stackName = unwrap(
    await p.text({
      message: "CloudFormation stack name",
      initialValue: existing?.stackName ?? "turjuman",
    }),
  );
  const region = unwrap(
    await p.text({
      message: "AWS region",
      initialValue: existing?.region ?? envRegion ?? "us-east-1",
    }),
  );
  const cors = unwrap(
    await p.text({
      message: "Allowed CORS origins (comma-separated, * for any)",
      initialValue: (existing?.corsAllowOrigins ?? ["*"]).join(","),
    }),
  );
  const memory = unwrap(
    await p.text({
      message: "Lambda memory (MB)",
      initialValue: String(existing?.functionMemorySize ?? 256),
      validate: (v) => (Number.isFinite(Number(v)) ? undefined : "Enter a number"),
    }),
  );
  const timeout = unwrap(
    await p.text({
      message: "Lambda timeout (seconds)",
      initialValue: String(existing?.functionTimeout ?? 15),
      validate: (v) => (Number.isFinite(Number(v)) ? undefined : "Enter a number"),
    }),
  );

  const useVpc = unwrap(
    await p.confirm({
      message: "Run the functions inside a VPC?",
      initialValue: Boolean(existing?.vpcSubnetIds?.length),
    }),
  );
  let vpcSubnetIds: string[] | undefined;
  let vpcSecurityGroupIds: string[] | undefined;
  if (useVpc) {
    vpcSubnetIds = splitList(
      unwrap(
        await p.text({
          message: "VPC subnet ids (comma-separated)",
          initialValue: (existing?.vpcSubnetIds ?? []).join(","),
        }),
      ),
    );
    vpcSecurityGroupIds = splitList(
      unwrap(
        await p.text({
          message: "VPC security group ids (comma-separated)",
          initialValue: (existing?.vpcSecurityGroupIds ?? []).join(","),
        }),
      ),
    );
  }

  return {
    stackName,
    region,
    deployBucket: existing?.deployBucket,
    corsAllowOrigins: splitList(cors),
    functionMemorySize: Number(memory),
    functionTimeout: Number(timeout),
    vpcSubnetIds,
    vpcSecurityGroupIds,
    ownerEmail: existing?.ownerEmail,
    ownerName: existing?.ownerName,
  };
}

export async function runDeploy(opts: { reconfigure?: boolean } = {}): Promise<void> {
  p.intro("Turjuman deploy");

  const existing = loadDeployConfig();
  if (existing && !opts.reconfigure) {
    p.log.info(`Using saved settings from turjuman.deploy.json (stack "${existing.stackName}").`);
    p.log.info("Run `turjuman deploy --reconfigure` to change them.");
  }
  let config = existing && !opts.reconfigure ? existing : await gatherConfig(existing);

  const root = findRepoRoot();

  // 1. Bundle every Lambda with esbuild.
  const buildSpin = p.spinner();
  buildSpin.start("Bundling functions");
  const artifacts: Artifact[] = [];
  for (const fn of DEPLOY_FUNCTIONS) {
    buildSpin.message(`Bundling ${fn.logicalId}`);
    artifacts.push(await bundleFunction(root, fn));
  }
  buildSpin.stop(`Bundled ${DEPLOY_FUNCTIONS.length} functions`);

  // 2. Ensure a deploy bucket and upload the zips.
  const s3 = new S3Client({ region: config.region });
  const uploadSpin = p.spinner();
  uploadSpin.start("Uploading artifacts to S3");
  const bucket = await ensureDeployBucket(s3, config.region, config.deployBucket);
  config = { ...config, deployBucket: bucket };
  const code: Record<string, { bucket: string; key: string }> = {};
  for (const a of artifacts) {
    const key = await uploadArtifact(s3, bucket, a.logicalId, a.hash, a.zip);
    code[a.logicalId] = { bucket, key };
  }
  uploadSpin.stop(`Uploaded ${artifacts.length} artifacts to ${bucket}`);

  // 3. Deploy the stack with the CDK toolkit (config is baked into the synthesized
  //    stack; the toolkit deploys with the ambient credentials, no bootstrap).
  const deploySpin = p.spinner();
  deploySpin.start("Deploying CloudFormation stack");
  let outputs: Record<string, string>;
  try {
    outputs = await deployStack({
      stackName: config.stackName,
      region: config.region,
      code,
      memorySize: config.functionMemorySize,
      timeout: config.functionTimeout,
      corsAllowOrigins: config.corsAllowOrigins,
      vpcSubnetIds: config.vpcSubnetIds,
      vpcSecurityGroupIds: config.vpcSecurityGroupIds,
    });
  } catch (err) {
    deploySpin.stop("Deploy failed");
    throw err;
  }
  deploySpin.stop("Stack deployed");

  saveDeployConfig(config);

  const apiUrl = outputs.ApiUrl;
  const tableName = outputs.TableName;
  if (!tableName) throw new Error("Stack did not return a TableName output — cannot bootstrap.");
  p.note(
    [
      `MCP URL:   ${outputs.McpUrl ?? "(missing)"}`,
      `API URL:   ${apiUrl ?? "(missing)"}`,
      `Table:     ${tableName ?? "(missing)"}`,
    ].join("\n"),
    "Stack outputs",
  );

  // 4. Create the first owner (once) and log in locally.
  let email = config.ownerEmail;
  let name = config.ownerName;
  if (!email) {
    email = unwrap(
      await p.text({
        message: "First owner email",
        validate: (v) => (v.includes("@") ? undefined : "Enter an email"),
      }),
    );
  }
  if (!name) {
    name = unwrap(await p.text({ message: "First owner name" }));
  }

  const bootSpin = p.spinner();
  bootSpin.start("Creating the first owner");
  const owner = await bootstrapFirstOwner({ region: config.region, tableName, email, name });
  bootSpin.stop(owner ? "Owner created" : "Owner already existed — keeping your existing key");

  config = { ...config, ownerEmail: email, ownerName: name };
  saveDeployConfig(config);

  if (owner) {
    if (apiUrl) saveAuth({ url: apiUrl, key: owner.apiKey });
    p.note(
      [
        `API key: ${owner.apiKey}`,
        "",
        "Store this now — it is shown only once.",
        apiUrl ? "Saved to ~/.turjuman/auth.json (you're logged in)." : "",
      ]
        .filter(Boolean)
        .join("\n"),
      "First owner",
    );
  } else {
    p.log.info("The org already has users; reuse your existing API key, or rotate it via the API.");
  }

  p.outro("Done. Point your MCP client at the MCP URL with your API key as a Bearer token.");
}
