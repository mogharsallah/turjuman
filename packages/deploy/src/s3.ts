import { randomBytes } from "node:crypto";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutBucketEncryptionCommand,
  PutObjectCommand,
  PutPublicAccessBlockCommand,
  S3Client,
} from "@aws-sdk/client-s3";

/**
 * Ensure an S3 bucket exists to hold the Lambda zips (the one piece of
 * "bootstrap" CloudFormation can't host for us). Returns the bucket name. If
 * `name` is given it is reused; otherwise a unique name is generated so the
 * caller can persist it for subsequent deploys.
 */
export async function ensureDeployBucket(
  client: S3Client,
  region: string,
  name?: string,
): Promise<string> {
  const bucket = name ?? `turjuman-deploy-${region}-${randomBytes(4).toString("hex")}`;

  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return bucket; // already exists and we can reach it
  } catch {
    // fall through to create
  }

  await client.send(
    new CreateBucketCommand({
      Bucket: bucket,
      // us-east-1 must NOT send a LocationConstraint; every other region must.
      ...(region === "us-east-1"
        ? {}
        : { CreateBucketConfiguration: { LocationConstraint: region as any } }),
    }),
  );
  await client.send(
    new PutPublicAccessBlockCommand({
      Bucket: bucket,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    }),
  );
  await client.send(
    new PutBucketEncryptionCommand({
      Bucket: bucket,
      ServerSideEncryptionConfiguration: {
        Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }],
      },
    }),
  );
  return bucket;
}

/**
 * Empty and delete the deploy bucket (the one resource teardown owns directly,
 * since it lives outside the CloudFormation stack). Pages through every object,
 * deletes them in batches, then drops the bucket. Tolerates an already-deleted
 * bucket so re-running teardown is safe. The deploy bucket is never versioned
 * (see `ensureDeployBucket`), so a plain ListObjectsV2 + DeleteObjects suffices.
 */
export async function emptyAndDeleteBucket(client: S3Client, bucket: string): Promise<void> {
  try {
    let token: string | undefined;
    do {
      const listed = await client.send(
        new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
      );
      const objects = (listed.Contents ?? [])
        .map((o) => o.Key)
        .filter((k): k is string => Boolean(k))
        .map((Key) => ({ Key }));
      if (objects.length > 0) {
        // ListObjectsV2 returns at most 1000 keys per page, matching the
        // DeleteObjects per-request cap, so one delete per page is within limits.
        await client.send(
          new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }),
        );
      }
      token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (token);

    await client.send(new DeleteBucketCommand({ Bucket: bucket }));
  } catch (err: any) {
    // Already gone — nothing to do.
    if (err?.name === "NoSuchBucket" || err?.$metadata?.httpStatusCode === 404) return;
    throw err;
  }
}

/** Upload a zip and return its S3 key. */
export async function uploadArtifact(
  client: S3Client,
  bucket: string,
  logicalId: string,
  hash: string,
  body: Buffer,
): Promise<string> {
  const key = `turjuman/artifacts/${logicalId}-${hash}.zip`;
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
  return key;
}
