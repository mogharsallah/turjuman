import { App } from "aws-cdk-lib";
import type { ICloudAssembly } from "@aws-cdk/cloud-assembly-schema";
import { NonInteractiveIoHost, StackSelectionStrategy, Toolkit } from "@aws-cdk/toolkit-lib";
import { TurjumanStack, type SynthOptions } from "./cdk.js";
import { STACK_TAGS } from "./stack.js";

/**
 * Deploy the Turjuman stack with the AWS CDK programmatic toolkit.
 *
 * The toolkit creates its own AWS SDK clients from the ambient environment
 * (credentials, region, and — for LocalStack — `AWS_ENDPOINT_URL`). Combined
 * with the stack's `CliCredentialsStackSynthesizer` and S3-referenced function
 * code (no CDK assets), this needs no `cdk bootstrap`. The stack is tagged
 * `turjuman:managed` so `status`/`teardown` can discover it.
 */
export async function deployStack(
  opts: SynthOptions & { region?: string },
): Promise<Record<string, string>> {
  if (opts.region) {
    // The toolkit resolves the target region from the environment.
    process.env.AWS_REGION = opts.region;
    process.env.AWS_DEFAULT_REGION = opts.region;
  }

  const toolkit = new Toolkit({ ioHost: new NonInteractiveIoHost({ logLevel: "error" }) });
  const source = await toolkit.fromAssemblyBuilder(async ({ outdir }) => {
    const app = new App({ outdir, analyticsReporting: false });
    new TurjumanStack(app, opts.stackName, opts);
    // aws-cdk-lib's CloudAssembly satisfies the toolkit's ICloudAssembly.
    return app.synth() as unknown as ICloudAssembly;
  });

  const result = await toolkit.deploy(source, {
    stacks: { strategy: StackSelectionStrategy.ALL_STACKS },
    tags: STACK_TAGS,
  });

  const stack = result.stacks[0];
  if (!stack) throw new Error("CDK deploy returned no stacks.");
  return stack.outputs;
}
