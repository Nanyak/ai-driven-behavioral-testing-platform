import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import type { BlobStore } from "./index.js";

type S3Like = Pick<S3Client, "send">;

function configFromEnv(): { client: S3ClientConfig; bucket: string } {
  const endpoint = process.env.S3_ENDPOINT ?? process.env.MINIO_ENDPOINT;
  const accessKeyId =
    process.env.S3_ACCESS_KEY_ID ?? process.env.MINIO_ROOT_USER ?? process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey =
    process.env.S3_SECRET_ACCESS_KEY ??
    process.env.MINIO_ROOT_PASSWORD ??
    process.env.AWS_SECRET_ACCESS_KEY;
  const client: S3ClientConfig = {
    region: process.env.S3_REGION ?? process.env.AWS_REGION ?? "us-east-1",
    forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? (endpoint ? "true" : "false")) === "true",
  };
  if (endpoint) client.endpoint = endpoint;
  if (accessKeyId && secretAccessKey) client.credentials = { accessKeyId, secretAccessKey };
  return { client, bucket: process.env.S3_BUCKET ?? "platwright" };
}

function key(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (
    normalized.length === 0 ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Invalid storage key "${value}"`);
  }
  return normalized;
}

function objectKey(value: string): string {
  const logical = key(value);
  if (
    (logical.startsWith("candidates/") || logical.startsWith("validation/")) &&
    !logical.endsWith(".json")
  ) {
    return `${logical}.json`;
  }
  return logical;
}

function logicalKey(value: string): string {
  if (
    (value.startsWith("candidates/") || value.startsWith("validation/")) &&
    value.endsWith(".json")
  ) {
    return value.slice(0, -".json".length);
  }
  return value;
}

async function bodyBuffer(body: unknown): Promise<Buffer> {
  if (
    body &&
    typeof body === "object" &&
    "transformToByteArray" in body &&
    typeof body.transformToByteArray === "function"
  ) {
    return Buffer.from(await body.transformToByteArray());
  }
  if (body instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  throw new Error("S3 returned an unsupported object body");
}

function missing(error: unknown): boolean {
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return value?.name === "NoSuchKey" || value?.name === "NotFound" || value?.$metadata?.httpStatusCode === 404;
}

export class S3BlobStore implements BlobStore {
  private readonly ready: Promise<void>;

  constructor(
    private readonly client: S3Like = new S3Client(configFromEnv().client),
    private readonly bucket = configFromEnv().bucket,
    ensureBucket = true
  ) {
    this.ready = ensureBucket ? this.createBucketIfMissing() : Promise.resolve();
  }

  private async createBucketIfMissing(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      if (!missing(error)) {
        // MinIO commonly reports a generic 404/NotFound; authentication and
        // network failures must remain loud.
        const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status !== 404) throw error;
      }
      try {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      } catch (createError) {
        const name = (createError as { name?: string }).name;
        if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") throw createError;
      }
    }
  }

  async get(value: string): Promise<Buffer | null> {
    await this.ready;
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: objectKey(value) })
      );
      return await bodyBuffer(result.Body);
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  async put(value: string, bytes: Buffer): Promise<void> {
    await this.ready;
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: objectKey(value), Body: bytes })
    );
  }

  async list(prefix: string): Promise<string[]> {
    await this.ready;
    const logical = key(prefix);
    const exact = await this.get(logical);
    if (exact !== null) return [logical];
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const result = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: `${logical}/`,
          ContinuationToken: continuationToken,
        })
      );
      for (const item of result.Contents ?? []) {
        if (item.Key) keys.push(logicalKey(item.Key));
      }
      continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (continuationToken);
    return keys.sort();
  }

  async delete(value: string): Promise<void> {
    await this.ready;
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey(value) })
    );
  }
}

export function makeS3BlobStore(): S3BlobStore {
  const config = configFromEnv();
  return new S3BlobStore(new S3Client(config.client), config.bucket);
}
