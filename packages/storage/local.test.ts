import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { makeLocalStorage } from "./local.js";

async function treeHashes(root: string, dir = root): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(hashes, await treeHashes(root, path));
    } else {
      const key = path.slice(root.length + 1);
      hashes[key] = createHash("sha256").update(await readFile(path)).digest("hex");
    }
  }
  return hashes;
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "storage-local-"));
  try {
    const local = makeLocalStorage(root);
    const value = { entries: [{ flow_signature: "abc", status: "approved" }] };

    await local.records.writeJson("hitl/approvals", value);
    assert.equal(
      await readFile(join(root, "data", "hitl", "approvals.json"), "utf8"),
      `${JSON.stringify(value, null, 2)}\n`
    );
    assert.deepEqual(await local.records.readJson("hitl/approvals"), value);
    assert.deepEqual(await local.records.list("hitl"), ["hitl/approvals"]);

    await local.blobs.put("candidates/test-candidates-run-1", Buffer.from("candidate\n"));
    assert.equal(
      await readFile(
        join(
          root,
          "services",
          "behavior-engine",
          "data",
          "candidates",
          "test-candidates-run-1.json"
        ),
        "utf8"
      ),
      "candidate\n"
    );
    assert.deepEqual(await local.blobs.list("candidates"), [
      "candidates/test-candidates-run-1",
    ]);

    await local.blobs.put(
      "sessions/session-flows-run-1.json",
      Buffer.from("[]\n")
    );
    await local.blobs.put("goldens/get-store-products-200.json", Buffer.from("{}\n"));
    await local.blobs.put(
      "endpoint-behavior/get_store_products.md",
      Buffer.from("# digest\n")
    );
    assert.deepEqual(await local.blobs.list("sessions"), [
      "sessions/session-flows-run-1.json",
    ]);
    assert.equal(
      (await local.blobs.get("goldens/get-store-products-200.json"))?.toString(),
      "{}\n"
    );

    const proposedAt = "2026-07-06T00:00:00.000Z";
    const invariant = {
      id: "invariant-1",
      flow_signature: "flow-1",
      flow_name: "Cart",
      cache_key: "cache-1",
      step_title: "POST /store/carts",
      source: "ai-proposed",
      polarity: "success",
      kind: "field",
      verified: false,
      payload: {
        id: "invariant-1",
        stepTitle: "POST /store/carts",
        rationale: "cart exists",
        source: "ai-proposed",
        polarity: "success",
        kind: "field",
        path: "cart.id",
        matcher: "toBeDefined",
        verified: false,
      },
      proposed_at: proposedAt,
      verified_at: null,
    };
    await local.invariants.replaceFlow({
      flow_signature: "flow-1",
      flow_name: "Cart",
      cache_key: "cache-1",
      proposed_at: proposedAt,
      invariants: [invariant],
    });
    await local.invariants.replaceFlow({
      flow_signature: "flow-2",
      flow_name: "Order",
      cache_key: "cache-2",
      proposed_at: proposedAt,
      invariants: [{ ...invariant, id: "invariant-2", flow_signature: "flow-2" }],
    });
    await local.invariants.replaceFlow({
      flow_signature: "flow-1",
      flow_name: "Cart changed",
      cache_key: "cache-3",
      proposed_at: proposedAt,
      invariants: [{ ...invariant, id: "invariant-3" }],
    });
    assert.deepEqual(
      (await local.invariants.list()).map((row) => row.id).sort(),
      ["invariant-2", "invariant-3"]
    );
    assert.equal(await local.invariants.markVerified(["invariant-3"]), 1);
    assert.deepEqual(
      (await local.invariants.list({ verifiedOnly: true })).map((row) => row.id),
      ["invariant-3"]
    );
    await Promise.all(
      ["flow-3", "flow-4"].map((flowSignature, index) =>
        local.invariants.replaceFlow({
          flow_signature: flowSignature,
          flow_name: flowSignature,
          cache_key: `cache-${index + 3}`,
          proposed_at: proposedAt,
          invariants: [
            {
              ...invariant,
              id: `invariant-${index + 4}`,
              flow_signature: flowSignature,
            },
          ],
        })
      )
    );
    assert.deepEqual(
      (await local.invariants.list()).map((row) => row.flow_signature).sort(),
      ["flow-1", "flow-2", "flow-3", "flow-4"]
    );

    await local.blobs.put("specs/customer/happy-path/a.spec.ts", Buffer.from("// spec\n"));
    assert.equal(
      (await local.blobs.get("specs/customer/happy-path/a.spec.ts"))?.toString("utf8"),
      "// spec\n"
    );
    await local.blobs.delete("specs/customer/happy-path/a.spec.ts");
    assert.equal(await local.blobs.get("specs/customer/happy-path/a.spec.ts"), null);

    // Representative mine -> generate -> test artifacts match the legacy direct
    // filesystem tree byte-for-byte (including JSON trailing-newline behavior).
    const legacyRoot = join(root, "legacy");
    const storageRoot = join(root, "storage");
    const throughStorage = makeLocalStorage(storageRoot);
    const approvals = { entries: [{ flow_signature: "abc", status: "approved" }] };
    const files: Array<[string, Buffer]> = [
      [
        "services/behavior-engine/data/candidates/test-candidates-run-1.json",
        Buffer.from('{"run_id":"run-1"}\n'),
      ],
      ["generated-tests/customer/happy-path/abc.spec.ts", Buffer.from("// exact spec\n")],
      [
        "generated-tests/.artifacts.json",
        Buffer.from(`${JSON.stringify({ version: 1, entries: [] }, null, 2)}\n`),
      ],
      ["reports/report.json", Buffer.from('{"status":"green"}')],
      ["reports/runs/run-1.html", Buffer.from("<html>green</html>")],
    ];
    const approvalPath = join(legacyRoot, "data", "hitl", "approvals.json");
    await mkdir(join(legacyRoot, "data", "hitl"), { recursive: true });
    await writeFile(approvalPath, `${JSON.stringify(approvals, null, 2)}\n`);
    for (const [path, bytes] of files) {
      const absolute = join(legacyRoot, path);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, bytes);
    }

    await throughStorage.records.writeJson("hitl/approvals", approvals);
    await throughStorage.blobs.put(
      "candidates/test-candidates-run-1",
      files[0][1]
    );
    await throughStorage.blobs.put("specs/customer/happy-path/abc.spec.ts", files[1][1]);
    await throughStorage.records.writeJson(
      "manifest",
      JSON.parse(files[2][1].toString("utf8"))
    );
    await throughStorage.blobs.put("reports/report.json", files[3][1]);
    await throughStorage.blobs.put("reports/runs/run-1.html", files[4][1]);

    assert.deepEqual(await treeHashes(storageRoot), await treeHashes(legacyRoot));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main()
  .then(() => console.log("local storage checks passed"))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
