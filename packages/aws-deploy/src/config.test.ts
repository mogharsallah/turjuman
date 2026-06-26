import { describe, expect, it } from "vitest";
import {
	applyOverrides,
	type DeployConfig,
	mapConfigToProps,
	migrateConfig,
} from "./config.js";

const base: DeployConfig = {
	version: 2,
	stackName: "turjuman",
	region: "us-east-1",
};

describe("migrateConfig", () => {
	it("folds the legacy flat config into the nested v2 shape", () => {
		const migrated = migrateConfig({
			stackName: "turjuman",
			region: "eu-west-1",
			functionTimeout: 30,
			functionMemorySize: 512,
			corsAllowOrigins: ["https://app.example.com"],
			vpcSubnetIds: ["subnet-1", "subnet-2"],
			vpcSecurityGroupIds: ["sg-1"],
			ownerEmail: "you@example.com",
			ownerName: "You",
			deployBucket: "turjuman-deploy-eu-west-1-abcd1234", // dropped
		});

		expect(migrated).toEqual({
			version: 2,
			stackName: "turjuman",
			region: "eu-west-1",
			ownerEmail: "you@example.com",
			ownerName: "You",
			functionDefaults: { memorySize: 512, timeout: 30 },
			corsAllowOrigins: ["https://app.example.com"],
			vpc: { subnetIds: ["subnet-1", "subnet-2"], securityGroupIds: ["sg-1"] },
		});
		expect("deployBucket" in migrated).toBe(false);
	});

	it("passes a v2 config through, validated", () => {
		expect(migrateConfig({ ...base, webhook: { enabled: false } })).toEqual({
			...base,
			webhook: { enabled: false },
		});
	});

	it("rejects an invalid config", () => {
		expect(() =>
			migrateConfig({ version: 2, stackName: "", region: "us-east-1" }),
		).toThrow();
	});
});

describe("mapConfigToProps", () => {
	it("keeps stack/table/surfaces but drops region, owner and code", () => {
		const props = mapConfigToProps({
			...base,
			ownerEmail: "you@example.com",
			ownerName: "You",
			table: { billingMode: "PROVISIONED", readCapacity: 5, writeCapacity: 5 },
			api: { enabled: false },
			corsAllowOrigins: ["*"],
		});

		expect(props).toEqual({
			stackName: "turjuman",
			table: { billingMode: "PROVISIONED", readCapacity: 5, writeCapacity: 5 },
			api: { enabled: false },
			corsAllowOrigins: ["*"],
		});
		expect("region" in props).toBe(false);
		expect("code" in props).toBe(false);
	});
});

describe("applyOverrides", () => {
	it("enables and disables surfaces", () => {
		expect(
			applyOverrides(base, { disable: ["api"], enable: ["webhook"] }),
		).toEqual({
			...base,
			api: { enabled: false },
			webhook: { enabled: true },
		});
	});

	it("rejects an unknown surface", () => {
		expect(() => applyOverrides(base, { enable: ["nope"] })).toThrow(
			/Unknown surface/,
		);
	});

	it("applies and coerces --set values (number, string, boolean)", () => {
		const next = applyOverrides(base, {
			set: [
				"mcp.memorySize=512",
				"table.billingMode=PROVISIONED",
				"table.pointInTimeRecovery=true",
			],
		});
		expect(next.mcp).toEqual({ memorySize: 512 });
		expect(next.table).toEqual({
			billingMode: "PROVISIONED",
			pointInTimeRecovery: true,
		});
	});

	it("re-validates through zod, rejecting an invalid value", () => {
		expect(() =>
			applyOverrides(base, { set: ["table.billingMode=NONSENSE"] }),
		).toThrow();
		expect(() => applyOverrides(base, { set: ["bogus"] })).toThrow(
			/Use path=value/,
		);
	});
});
