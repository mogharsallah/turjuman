import {
  CloudFormationClient,
  DeleteStackCommand,
  DescribeStacksCommand,
  ListStackResourcesCommand,
} from "@aws-sdk/client-cloudformation";

/**
 * Tags stamped on every Turjuman stack at deploy time. `findManagedStacks`
 * keys off `turjuman:managed` so `status`/`teardown` can locate installs even
 * when the operator renamed the stack or has no local turjuman.deploy.json.
 */
export const STACK_TAGS: { Key: string; Value: string }[] = [
  { Key: "app", Value: "turjuman" },
  { Key: "turjuman:managed", Value: "true" },
];
const MANAGED_TAG_KEY = "turjuman:managed";
const MANAGED_TAG_VALUE = "true";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Current status of a stack, or undefined if it does not exist. */
async function stackStatus(cfn: CloudFormationClient, name: string): Promise<string | undefined> {
  try {
    const res = await cfn.send(new DescribeStacksCommand({ StackName: name }));
    return res.Stacks?.[0]?.StackStatus;
  } catch (err: any) {
    if (err?.name === "ValidationError") return undefined; // does not exist
    throw err;
  }
}

const tagsToMap = (tags?: { Key?: string; Value?: string }[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const t of tags ?? []) if (t.Key) out[t.Key] = t.Value ?? "";
  return out;
};

const outputsToMap = (outputs?: { OutputKey?: string; OutputValue?: string }[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const o of outputs ?? []) if (o.OutputKey) out[o.OutputKey] = o.OutputValue ?? "";
  return out;
};

export interface StackInfo {
  stackName: string;
  status: string;
  outputs: Record<string, string>;
  tags: Record<string, string>;
}

/** Describe a single stack by name, or undefined if it does not exist. */
export async function describeStack(
  cfn: CloudFormationClient,
  name: string,
): Promise<StackInfo | undefined> {
  try {
    const res = await cfn.send(new DescribeStacksCommand({ StackName: name }));
    const stack = res.Stacks?.[0];
    if (!stack) return undefined;
    return {
      stackName: stack.StackName ?? name,
      status: stack.StackStatus ?? "",
      outputs: outputsToMap(stack.Outputs),
      tags: tagsToMap(stack.Tags),
    };
  } catch (err: any) {
    if (err?.name === "ValidationError") return undefined; // does not exist
    throw err;
  }
}

/**
 * Find every Turjuman-managed stack in the client's region by the
 * `turjuman:managed` tag. Pages through all stacks (DescribeStacks with no
 * name lists non-deleted stacks) and filters client-side, so it works even for
 * renamed stacks with no local config. CloudFormation is regional — this only
 * sees the region the client was constructed with.
 */
export async function findManagedStacks(cfn: CloudFormationClient): Promise<StackInfo[]> {
  const found: StackInfo[] = [];
  let token: string | undefined;
  do {
    const res = await cfn.send(new DescribeStacksCommand({ NextToken: token }));
    for (const stack of res.Stacks ?? []) {
      const tags = tagsToMap(stack.Tags);
      if (tags[MANAGED_TAG_KEY] !== MANAGED_TAG_VALUE) continue;
      if (stack.StackStatus === "DELETE_COMPLETE") continue;
      found.push({
        stackName: stack.StackName ?? "",
        status: stack.StackStatus ?? "",
        outputs: outputsToMap(stack.Outputs),
        tags,
      });
    }
    token = res.NextToken;
  } while (token);
  return found;
}

/** Find the first resource of a given type in a stack (logical + physical id). */
export async function findStackResource(
  cfn: CloudFormationClient,
  stackName: string,
  resourceType: string,
): Promise<{ logicalId: string; physicalId?: string } | undefined> {
  let token: string | undefined;
  do {
    const res = await cfn.send(
      new ListStackResourcesCommand({ StackName: stackName, NextToken: token }),
    );
    for (const r of res.StackResourceSummaries ?? []) {
      if (r.ResourceType === resourceType && r.LogicalResourceId) {
        return { logicalId: r.LogicalResourceId, physicalId: r.PhysicalResourceId };
      }
    }
    token = res.NextToken;
  } while (token);
  return undefined;
}

/** Issue a single DeleteStack and poll until the stack is gone or DELETE_FAILED. */
async function attemptDelete(
  cfn: CloudFormationClient,
  name: string,
  retainResources: string[] | undefined,
  log: (msg: string) => void,
): Promise<"gone" | "failed"> {
  await cfn.send(
    new DeleteStackCommand({
      StackName: name,
      // RetainResources is only honored when re-deleting a DELETE_FAILED stack.
      ...(retainResources?.length ? { RetainResources: retainResources } : {}),
    }),
  );

  let last = "";
  for (;;) {
    const status = await stackStatus(cfn, name);
    if (status === undefined) return "gone"; // DELETE_COMPLETE
    if (status !== last) {
      log(`Stack status: ${status}`);
      last = status;
    }
    if (status === "DELETE_FAILED") return "failed";
    await sleep(5000);
  }
}

/**
 * Delete a stack and wait for it to disappear. A no-op (already gone) resolves
 * immediately, so teardown is idempotent across re-runs.
 *
 * `retainResources` lets a destructive delete preserve specific resources (e.g.
 * a DynamoDB table whose deletion protection is enabled). CloudFormation only
 * honors RetainResources on a DELETE_FAILED stack, so we delete once, and if the
 * protected resource blocks completion, re-delete retaining it.
 */
export async function deleteStack(
  cfn: CloudFormationClient,
  name: string,
  opts: { onStatus?: (msg: string) => void; retainResources?: string[] } = {},
): Promise<void> {
  const log = opts.onStatus ?? (() => {});

  if ((await stackStatus(cfn, name)) === undefined) {
    log("Stack does not exist — nothing to delete.");
    return;
  }

  const first = await attemptDelete(cfn, name, undefined, log);
  if (first === "gone") return;

  if (opts.retainResources?.length) {
    log("Retrying delete, retaining the table…");
    const second = await attemptDelete(cfn, name, opts.retainResources, log);
    if (second === "gone") return;
  }

  throw new Error(
    `Delete failed — stack status DELETE_FAILED. Some resources may have been retained; check the CloudFormation console.`,
  );
}
