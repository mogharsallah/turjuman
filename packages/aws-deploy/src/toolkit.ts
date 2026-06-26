import type { ICloudAssembly } from "@aws-cdk/cloud-assembly-schema";
import {
	BootstrapEnvironments,
	NonInteractiveIoHost,
	StackSelectionStrategy,
	Toolkit,
} from "@aws-cdk/toolkit-lib";
import { TurjumanStack, type TurjumanStackProps } from "@turjuman/aws-cdk";
import { App } from "aws-cdk-lib";
import { STACK_TAGS } from "./stack.js";

export interface DeployStackOptions {
	/** Stack props (stackName + the construct config). */
	props: TurjumanStackProps;
	region?: string;
	/** Skip the standard CDK bootstrap (for accounts the caller already bootstrapped). */
	skipBootstrap?: boolean;
}

/**
 * Deploy the Turjuman stack (from @turjuman/aws-cdk) with the AWS CDK programmatic
 * toolkit. Uses the default stack synthesizer, so it publishes the Lambda assets
 * through the standard CDK bootstrap staging bucket. Unless `skipBootstrap` is
 * set, it first runs `toolkit.bootstrap` (idempotent) to create/update the shared
 * `CDKToolkit` stack the asset pipeline needs.
 *
 * The toolkit creates its own AWS SDK clients from the ambient environment
 * (credentials, region, and — for LocalStack — `AWS_ENDPOINT_URL`). The stack is
 * tagged `turjuman:managed` so `status`/`teardown` can discover it.
 */
export async function deployStack(
	opts: DeployStackOptions,
): Promise<Record<string, string>> {
	if (opts.region) {
		// The toolkit resolves the target region from the environment.
		process.env.AWS_REGION = opts.region;
		process.env.AWS_DEFAULT_REGION = opts.region;
	}
	const stackName = opts.props.stackName ?? "turjuman";

	const toolkit = new Toolkit({
		ioHost: new NonInteractiveIoHost({ logLevel: "error" }),
	});
	const source = await toolkit.fromAssemblyBuilder(async ({ outdir }) => {
		const app = new App({ outdir, analyticsReporting: false });
		new TurjumanStack(app, stackName, opts.props);
		// aws-cdk-lib's CloudAssembly satisfies the toolkit's ICloudAssembly.
		return app.synth() as unknown as ICloudAssembly;
	});

	if (!opts.skipBootstrap) {
		// Standard CDK bootstrap (idempotent): creates/updates the shared CDKToolkit
		// stack (staging bucket + roles + SSM version) the default synthesizer needs
		// to publish assets. Account/region are inferred from the assembly.
		await toolkit.bootstrap(
			BootstrapEnvironments.fromCloudAssemblySource(source),
		);
	}

	const result = await toolkit.deploy(source, {
		stacks: { strategy: StackSelectionStrategy.ALL_STACKS },
		tags: STACK_TAGS,
	});

	const stack = result.stacks[0];
	if (!stack) throw new Error("CDK deploy returned no stacks.");
	return stack.outputs;
}
