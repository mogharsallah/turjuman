import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Replayable deploy settings, written next to the repo so a second
 * `turjuman deploy` runs non-interactively and updates in place. Safe to
 * commit: it contains no secrets (the API key is shown once and never stored).
 */
export const DEPLOY_CONFIG_FILE = "turjuman.deploy.json";

export interface DeployConfig {
  stackName: string;
  region: string;
  /** S3 bucket holding the Lambda zips (created on first deploy). */
  deployBucket?: string;
  /** CloudFormation template parameters. */
  functionTimeout?: number;
  functionMemorySize?: number;
  corsAllowOrigins?: string[];
  vpcSubnetIds?: string[];
  vpcSecurityGroupIds?: string[];
  /** Remembered for re-runs; the owner is only created once. */
  ownerEmail?: string;
  ownerName?: string;
}

export function loadDeployConfig(cwd = process.cwd()): DeployConfig | undefined {
  const file = join(cwd, DEPLOY_CONFIG_FILE);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as DeployConfig;
}

export function saveDeployConfig(config: DeployConfig, cwd = process.cwd()): string {
  const file = join(cwd, DEPLOY_CONFIG_FILE);
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  return file;
}
