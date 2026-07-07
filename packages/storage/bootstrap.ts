import { makePgPool, applyMigrations } from "./postgres.js";
import { makeS3BlobStore } from "./s3.js";

if ((process.env.STORAGE_BACKEND ?? "local") === "remote") {
  const required = [
    "MINIO_ENDPOINT",
    "MINIO_ROOT_USER",
    "MINIO_ROOT_PASSWORD",
    "S3_BUCKET",
  ];
  const missing = required.filter((name) => !process.env[name]?.trim());
  // The storage DB accepts either the platform-dedicated var or a lone DATABASE_URL.
  if (!process.env.PLATFORM_DATABASE_URL?.trim() && !process.env.DATABASE_URL?.trim()) {
    missing.unshift("PLATFORM_DATABASE_URL");
  }
  if (missing.length > 0) {
    throw new Error(`Remote storage configuration is missing: ${missing.join(", ")}`);
  }

  const pool = makePgPool();
  try {
    await applyMigrations(pool);
    // Any operation waits for the S3BlobStore's idempotent bucket bootstrap.
    await makeS3BlobStore().list("__bootstrap__");
    console.log("remote storage bootstrap complete");
  } finally {
    await pool.end();
  }
} else {
  console.log("local storage selected; remote bootstrap skipped");
}
