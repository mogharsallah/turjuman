import { UpdateTableCommand } from "@aws-sdk/client-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { enableTableDeletionProtection } from "./dynamo.js";

describe("enableTableDeletionProtection", () => {
	it("enables deletion protection on the named table", async () => {
		const send = vi.fn(async () => ({}));
		await enableTableDeletionProtection({ send } as any, "turjuman-Table");
		const cmd = send.mock.calls[0][0];
		expect(cmd).toBeInstanceOf(UpdateTableCommand);
		expect(cmd.input).toMatchObject({
			TableName: "turjuman-Table",
			DeletionProtectionEnabled: true,
		});
	});
});
