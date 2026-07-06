import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S3BlobStore } from "./s3.js";
import { getDir, putDir } from "./transfer.js";

class MemoryS3 {
  readonly objects = new Map<string, Buffer>();

  async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
    const name = command.constructor.name;
    const key = command.input.Key as string;
    if (name === "PutObjectCommand") {
      this.objects.set(key, Buffer.from(command.input.Body as Uint8Array));
      return {};
    }
    if (name === "GetObjectCommand") {
      const bytes = this.objects.get(key);
      if (!bytes) throw { name: "NoSuchKey" };
      return {
        Body: {
          transformToByteArray: async () => Uint8Array.from(bytes),
        },
      };
    }
    if (name === "DeleteObjectCommand") {
      this.objects.delete(key);
      return {};
    }
    if (name === "ListObjectsV2Command") {
      const prefix = command.input.Prefix as string;
      return {
        Contents: [...this.objects.keys()]
          .filter((value) => value.startsWith(prefix))
          .map((Key) => ({ Key })),
        IsTruncated: false,
      };
    }
    throw new Error(`Unexpected command ${name}`);
  }
}

async function main(): Promise<void> {
  const client = new MemoryS3();
  const blobs = new S3BlobStore(client as never, "test", false);
  const original = Buffer.from([0, 1, 2, 3, 255, 10, 13]);

  await blobs.put("specs/customer/exact.spec.ts", original);
  assert.deepEqual(await blobs.get("specs/customer/exact.spec.ts"), original);
  assert.deepEqual(await blobs.list("specs"), ["specs/customer/exact.spec.ts"]);
  assert.equal(await blobs.get("specs/missing.spec.ts"), null);
  await blobs.put("candidates/test-candidates-run-1", Buffer.from("{}\n"));
  assert.ok(client.objects.has("candidates/test-candidates-run-1.json"));
  assert.deepEqual(await blobs.list("candidates"), [
    "candidates/test-candidates-run-1",
  ]);

  const root = await mkdtemp(join(tmpdir(), "storage-remote-"));
  try {
    const hydrated = join(root, "hydrated");
    await getDir(blobs, "specs", hydrated);
    const roundTrip = await readFile(join(hydrated, "customer", "exact.spec.ts"));
    assert.equal(
      createHash("sha256").update(roundTrip).digest("hex"),
      createHash("sha256").update(original).digest("hex")
    );
    await getDir(blobs, "candidates", join(root, "candidates"));
    assert.equal(
      await readFile(join(root, "candidates", "test-candidates-run-1.json"), "utf8"),
      "{}\n"
    );

    const reports = join(root, "reports");
    await mkdir(join(reports, "runs"), { recursive: true });
    await writeFile(join(reports, "runs", "run-1.json"), '{"status":"green"}');
    assert.equal(await putDir(blobs, reports, "reports"), 1);
    assert.equal(
      (await blobs.get("reports/runs/run-1.json"))?.toString("utf8"),
      '{"status":"green"}'
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  await blobs.delete("specs/customer/exact.spec.ts");
  assert.equal(await blobs.get("specs/customer/exact.spec.ts"), null);
  await assert.rejects(() => blobs.put("../escape", Buffer.from("bad")), /Invalid storage key/);
}

main()
  .then(() => console.log("remote storage checks passed"))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
