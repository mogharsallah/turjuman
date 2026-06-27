import { CfnOutput, Stack } from "aws-cdk-lib";
import type { Construct } from "constructs";
import type { TurjumanStackProps } from "./props.js";
import { Turjuman } from "./turjuman.js";

/**
 * A standalone CloudFormation stack wrapping the {@link Turjuman} construct, for
 * a plain `cdk deploy` (or the repo's dev/e2e deploy scripts). Uses the default
 * stack synthesizer, so it deploys through the standard CDK bootstrap + asset
 * pipeline. The three outputs (McpUrl, ApiUrl, TableName) carry stable keys the
 * deployer reads back; ApiUrl is omitted when the REST API surface is disabled.
 */
export class TurjumanStack extends Stack {
	readonly turjuman: Turjuman;

	constructor(scope: Construct, id: string, props: TurjumanStackProps = {}) {
		super(scope, id, { stackName: props.stackName });

		const turjuman = new Turjuman(this, "Turjuman", props);
		this.turjuman = turjuman;

		new CfnOutput(this, "McpUrl", { value: turjuman.mcpUrl.url });
		if (turjuman.apiUrl) {
			new CfnOutput(this, "ApiUrl", { value: turjuman.apiUrl.url });
		}
		new CfnOutput(this, "TableName", { value: turjuman.table.tableName });
	}
}
