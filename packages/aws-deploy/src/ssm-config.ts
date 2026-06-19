import {
  DeleteParameterCommand,
  GetParameterCommand,
  PutParameterCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";
import { clientConfig } from "./aws.js";
import { type DeployConfig, migrateConfig } from "./config.js";

/**
 * The canonical deploy config lives in an AWS SSM parameter so a redeploy works
 * from any machine/CI (CloudFormation can't hand inputs back). The local
 * `turjuman.deploy.json` is only a cache; on conflict, SSM wins. Owner email/name
 * are PII and are kept out of this shared copy.
 */
export function ssmConfigPath(stackName: string): string {
  return `/turjuman/${stackName}/deploy-config`;
}

export async function loadSsmConfig(
  region: string,
  stackName: string,
): Promise<DeployConfig | undefined> {
  const ssm = new SSMClient(clientConfig(region));
  try {
    const res = await ssm.send(new GetParameterCommand({ Name: ssmConfigPath(stackName) }));
    const raw = res.Parameter?.Value;
    return raw ? migrateConfig(JSON.parse(raw)) : undefined;
  } catch (err) {
    if ((err as { name?: string }).name === "ParameterNotFound") return undefined;
    throw err;
  }
}

export async function saveSsmConfig(region: string, config: DeployConfig): Promise<void> {
  const ssm = new SSMClient(clientConfig(region));
  // Strip PII (owner email/name) from the shared canonical copy.
  const { ownerEmail: _e, ownerName: _n, ...shareable } = config;
  await ssm.send(
    new PutParameterCommand({
      Name: ssmConfigPath(config.stackName),
      Type: "String",
      Overwrite: true,
      Value: JSON.stringify(shareable),
    }),
  );
}

export async function deleteSsmConfig(region: string, stackName: string): Promise<void> {
  const ssm = new SSMClient(clientConfig(region));
  try {
    await ssm.send(new DeleteParameterCommand({ Name: ssmConfigPath(stackName) }));
  } catch (err) {
    if ((err as { name?: string }).name === "ParameterNotFound") return;
    throw err;
  }
}
