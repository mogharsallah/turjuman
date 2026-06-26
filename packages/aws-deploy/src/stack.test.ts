import {
	DeleteStackCommand,
	DescribeStacksCommand,
	ListStackResourcesCommand,
} from "@aws-sdk/client-cloudformation";
import { describe, expect, it, vi } from "vitest";
import {
	deleteStack,
	describeStack,
	findManagedStacks,
	findStackResource,
} from "./stack.js";

/** A minimal CloudFormationClient stub whose `send` dispatches per command type. */
function stubClient(handlers: Record<string, (input: any) => any>) {
	const send = vi.fn(async (cmd: any) => {
		const name = cmd.constructor.name;
		const handler = handlers[name];
		if (!handler) throw new Error(`Unexpected command: ${name}`);
		return handler(cmd.input);
	});
	return { client: { send } as any, send };
}

const validationError = () =>
	Object.assign(new Error("does not exist"), { name: "ValidationError" });

describe("describeStack", () => {
	it("returns undefined when the stack does not exist", async () => {
		const { client } = stubClient({
			[DescribeStacksCommand.name]: () => {
				throw validationError();
			},
		});
		expect(await describeStack(client, "turjuman")).toBeUndefined();
	});

	it("maps outputs and tags into plain objects", async () => {
		const { client } = stubClient({
			[DescribeStacksCommand.name]: () => ({
				Stacks: [
					{
						StackName: "turjuman",
						StackStatus: "CREATE_COMPLETE",
						Outputs: [
							{ OutputKey: "TableName", OutputValue: "turjuman-Table" },
						],
						Tags: [{ Key: "turjuman:managed", Value: "true" }],
					},
				],
			}),
		});
		const info = await describeStack(client, "turjuman");
		expect(info).toMatchObject({
			stackName: "turjuman",
			status: "CREATE_COMPLETE",
			outputs: { TableName: "turjuman-Table" },
			tags: { "turjuman:managed": "true" },
		});
	});
});

describe("findManagedStacks", () => {
	it("filters by the managed tag and follows pagination", async () => {
		const pages = [
			{
				Stacks: [
					{
						StackName: "turjuman",
						StackStatus: "CREATE_COMPLETE",
						Tags: [{ Key: "turjuman:managed", Value: "true" }],
					},
					{
						StackName: "unrelated",
						StackStatus: "CREATE_COMPLETE",
						Tags: [{ Key: "app", Value: "other" }],
					},
				],
				NextToken: "page2",
			},
			{
				Stacks: [
					{
						StackName: "turjuman-staging",
						StackStatus: "UPDATE_COMPLETE",
						Tags: [{ Key: "turjuman:managed", Value: "true" }],
					},
					{
						StackName: "deleted",
						StackStatus: "DELETE_COMPLETE",
						Tags: [{ Key: "turjuman:managed", Value: "true" }],
					},
				],
			},
		];
		let call = 0;
		const { client, send } = stubClient({
			[DescribeStacksCommand.name]: () => pages[call++],
		});

		const found = await findManagedStacks(client);
		expect(found.map((s) => s.stackName)).toEqual([
			"turjuman",
			"turjuman-staging",
		]);
		expect(send).toHaveBeenCalledTimes(2);
	});
});

describe("deleteStack", () => {
	it("returns immediately when the stack is already gone", async () => {
		const { client, send } = stubClient({
			[DescribeStacksCommand.name]: () => {
				throw validationError();
			},
		});
		await deleteStack(client, "turjuman");
		// Only the existence check ran — no DeleteStack.
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("issues a delete then polls until the stack disappears", async () => {
		const statuses = ["DELETE_IN_PROGRESS", "DELETE_IN_PROGRESS"];
		let describeCalls = 0;
		const { send, client } = stubClient({
			[DescribeStacksCommand.name]: () => {
				// First call = existence check (exists), then in-progress, then gone.
				describeCalls++;
				if (describeCalls === 1)
					return { Stacks: [{ StackStatus: "CREATE_COMPLETE" }] };
				if (statuses.length)
					return { Stacks: [{ StackStatus: statuses.shift()! }] };
				throw validationError();
			},
			[DeleteStackCommand.name]: () => ({}),
		});

		vi.useFakeTimers();
		const done = deleteStack(client, "turjuman");
		await vi.runAllTimersAsync();
		await done;
		vi.useRealTimers();

		expect(
			send.mock.calls.some(([cmd]) => cmd instanceof DeleteStackCommand),
		).toBe(true);
	});

	it("throws on DELETE_FAILED", async () => {
		let describeCalls = 0;
		const { client } = stubClient({
			[DescribeStacksCommand.name]: () => {
				describeCalls++;
				if (describeCalls === 1)
					return { Stacks: [{ StackStatus: "CREATE_COMPLETE" }] };
				return { Stacks: [{ StackStatus: "DELETE_FAILED" }] };
			},
			[DeleteStackCommand.name]: () => ({}),
		});
		await expect(deleteStack(client, "turjuman")).rejects.toThrow(
			/DELETE_FAILED/,
		);
	});

	it("retries with RetainResources when the first delete fails, then succeeds", async () => {
		// existence check (exists) -> first delete poll (DELETE_FAILED) ->
		// second delete poll (gone).
		const sequence = ["CREATE_COMPLETE", "DELETE_FAILED"];
		let i = 0;
		const { client, send } = stubClient({
			[DescribeStacksCommand.name]: () => {
				const status = sequence[i++];
				if (status === undefined) throw validationError(); // gone after the retry
				return { Stacks: [{ StackStatus: status }] };
			},
			[DeleteStackCommand.name]: () => ({}),
		});

		await deleteStack(client, "turjuman", { retainResources: ["Table"] });

		const deletes = send.mock.calls
			.map(([c]) => c)
			.filter((c) => c instanceof DeleteStackCommand);
		expect(deletes).toHaveLength(2);
		expect(deletes[0].input.RetainResources).toBeUndefined();
		expect(deletes[1].input.RetainResources).toEqual(["Table"]);
	});
});

describe("findStackResource", () => {
	it("returns the logical and physical id of the first matching resource", async () => {
		const { client } = stubClient({
			[ListStackResourcesCommand.name]: () => ({
				StackResourceSummaries: [
					{
						ResourceType: "AWS::Lambda::Function",
						LogicalResourceId: "ApiFunction",
					},
					{
						ResourceType: "AWS::DynamoDB::Table",
						LogicalResourceId: "Table",
						PhysicalResourceId: "turjuman-Table-XYZ",
					},
				],
			}),
		});
		expect(
			await findStackResource(client, "turjuman", "AWS::DynamoDB::Table"),
		).toEqual({
			logicalId: "Table",
			physicalId: "turjuman-Table-XYZ",
		});
	});

	it("returns undefined when no resource matches", async () => {
		const { client } = stubClient({
			[ListStackResourcesCommand.name]: () => ({ StackResourceSummaries: [] }),
		});
		expect(
			await findStackResource(client, "turjuman", "AWS::DynamoDB::Table"),
		).toBeUndefined();
	});
});
