import {
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { emptyAndDeleteBucket } from "./s3.js";

function stubClient(handlers: Record<string, (input: any) => any>) {
  const send = vi.fn(async (cmd: any) => {
    const name = cmd.constructor.name;
    const handler = handlers[name];
    if (!handler) throw new Error(`Unexpected command: ${name}`);
    return handler(cmd.input);
  });
  return { client: { send } as any, send };
}

describe("emptyAndDeleteBucket", () => {
  it("pages through objects, deletes each page, then deletes the bucket", async () => {
    const pages = [
      { Contents: [{ Key: "a" }, { Key: "b" }], IsTruncated: true, NextContinuationToken: "t2" },
      { Contents: [{ Key: "c" }], IsTruncated: false },
    ];
    let call = 0;
    const deleted: string[][] = [];
    const { client, send } = stubClient({
      [ListObjectsV2Command.name]: () => pages[call++],
      [DeleteObjectsCommand.name]: (input) => {
        deleted.push(input.Delete.Objects.map((o: any) => o.Key));
        return {};
      },
      [DeleteBucketCommand.name]: () => ({}),
    });

    await emptyAndDeleteBucket(client, "turjuman-deploy-us-east-1-abcd1234");

    expect(deleted).toEqual([["a", "b"], ["c"]]);
    // DeleteBucket runs last.
    const lastCmd = send.mock.calls.at(-1)![0];
    expect(lastCmd).toBeInstanceOf(DeleteBucketCommand);
  });

  it("skips DeleteObjects when the bucket is already empty", async () => {
    const { client, send } = stubClient({
      [ListObjectsV2Command.name]: () => ({ Contents: [], IsTruncated: false }),
      [DeleteBucketCommand.name]: () => ({}),
    });
    await emptyAndDeleteBucket(client, "bucket");
    expect(send.mock.calls.some(([c]) => c instanceof DeleteObjectsCommand)).toBe(false);
  });

  it("tolerates an already-deleted bucket", async () => {
    const { client } = stubClient({
      [ListObjectsV2Command.name]: () => {
        throw Object.assign(new Error("gone"), { name: "NoSuchBucket" });
      },
    });
    await expect(emptyAndDeleteBucket(client, "bucket")).resolves.toBeUndefined();
  });
});
