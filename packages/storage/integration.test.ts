import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { makeRemoteStorage } from "./remote.js";

const store = makeRemoteStorage();
await store.records.readJson("manifest");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await pool.query(
  "truncate table decisions, dismissed_relationships, run_index, manifest, storage_metadata, invariants"
);
const suffix = randomUUID();
const reviewId = `${"a".repeat(64)}:200-${suffix}`;
const decision = {
  review_id: reviewId,
  flow_signature: "a".repeat(64),
  status_signature: "200",
  status: "approved",
  decided_at: new Date().toISOString(),
  payload_extension: { preserved: true },
};

await store.records.writeJson("hitl/approvals", { entries: [decision] });
assert.deepEqual(
  await store.records.readJson("hitl/approvals"),
  { entries: [decision] }
);

const relationship = {
  review_ids: [reviewId, `${"b".repeat(64)}:401`],
  dismissed_at: new Date().toISOString(),
};
await store.records.writeJson("hitl/dismissed-relationships", {
  dismissed: [relationship],
});
assert.deepEqual(
  await store.records.readJson("hitl/dismissed-relationships"),
  { dismissed: [relationship] }
);

const manifest = {
  version: 1,
  generated_at: new Date().toISOString(),
  entries: [{ review_id: reviewId, flow_signature: "a".repeat(64), test_path: "customer/a.spec.ts" }],
};
await store.records.writeJson("manifest", manifest);
assert.deepEqual(await store.records.readJson("manifest"), manifest);

const run = {
  run_id: suffix,
  slug: suffix,
  generated_at: new Date().toISOString(),
  status: "green",
  totals: { executed: 1, passed: 1, failed: 0, skipped: 0 },
};
await store.records.writeJson("run-index", { entries: [run] });
assert.deepEqual(await store.records.readJson("run-index"), { entries: [run] });

const bytes = Buffer.from([0, 255, 1, 2, 10, 13]);
const objectKey = `specs/integration/${suffix}.spec.ts`;
await store.blobs.put(objectKey, bytes);
const loaded = await store.blobs.get(objectKey);
assert.equal(
  createHash("sha256").update(loaded ?? Buffer.alloc(0)).digest("hex"),
  createHash("sha256").update(bytes).digest("hex")
);
assert.ok((await store.blobs.list("specs/integration")).includes(objectKey));
await store.blobs.delete(objectKey);
assert.equal(await store.blobs.get(objectKey), null);

const proposedAt = new Date().toISOString();
const invariant = {
  id: `invariant-${suffix}`,
  flow_signature: "flow-a",
  flow_name: "Flow A",
  cache_key: "cache-a",
  step_title: "GET /store/products",
  source: "ai-proposed",
  polarity: "success",
  kind: "field",
  verified: false,
  payload: {
    stepTitle: "GET /store/products",
    rationale: "products are present",
    source: "ai-proposed",
    polarity: "success",
    kind: "field",
    path: "products",
    matcher: "toBeDefined",
    verified: false,
  },
  proposed_at: proposedAt,
  verified_at: null,
};
await store.invariants.replaceFlow({
  flow_signature: "flow-a",
  flow_name: "Flow A",
  cache_key: "cache-a",
  proposed_at: proposedAt,
  invariants: [invariant],
});
assert.equal((await store.invariants.list()).length, 1);
assert.equal(await store.invariants.markVerified([invariant.id]), 1);
assert.equal((await store.invariants.list({ verifiedOnly: true }))[0]?.id, invariant.id);
await store.invariants.replaceFlow({
  flow_signature: "flow-a",
  flow_name: "Flow A changed",
  cache_key: "cache-b",
  proposed_at: new Date().toISOString(),
  invariants: [],
});
assert.equal((await store.invariants.list()).length, 0);

// A logical delete retires the row from current reads while retaining its audit payload.
await store.records.writeJson("hitl/approvals", { entries: [] });
assert.equal(await store.records.readJson("hitl/approvals"), null);
try {
  const audit = await pool.query<{ retired_at: Date | null; payload: unknown }>(
    "select retired_at, payload from decisions where review_id=$1",
    [reviewId]
  );
  assert.equal(audit.rows.length, 1);
  assert.ok(audit.rows[0].retired_at instanceof Date);
  assert.deepEqual(audit.rows[0].payload, decision);
} finally {
  await pool.end();
}

console.log("remote integration checks passed");
