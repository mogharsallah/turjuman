import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "aws-cdk-lib";
import type { TurjumanStackProps } from "./props.js";
import { TurjumanStack } from "./stack.js";

/**
 * Synthesize the Turjuman stack to a plain CloudFormation template object, for
 * tests and inspection. Writes to a throwaway temp dir that is removed before
 * returning, so this is a pure function from the caller's view. The real deploy
 * goes through the CDK toolkit, which synthesizes the same stack.
 *
 * Pass `code` overrides (Code.fromAsset of a fixture dir) to keep synth hermetic
 * — otherwise the default code resolves the published @turjuman/mcp-server /
 * @turjuman/api Lambda assets, which must have been built.
 */
export function synthTemplate(props: TurjumanStackProps = {}): Record<string, unknown> {
  const outdir = mkdtempSync(join(tmpdir(), "turjuman-cdk-"));
  try {
    const app = new App({ outdir, analyticsReporting: false });
    const stack = new TurjumanStack(app, props.stackName ?? "turjuman", props);
    const assembly = app.synth();
    return assembly.getStackArtifact(stack.artifactId).template as Record<string, unknown>;
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
}
