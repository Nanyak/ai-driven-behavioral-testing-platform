import { makeLocalStorage } from "./local.js";
import { makeRemoteStorage } from "./remote.js";

// One-shot seed of the remote backend from the committed local files. SKIP-EXISTING
// by design: anything already present remotely is left untouched, so a re-run can
// never clobber data that has since diverged in Postgres/MinIO. Run it as many
// times as you like — it only ever fills gaps.

const local = makeLocalStorage();
const remote = makeRemoteStorage();

// Records are whole documents (e.g. approvals = the entire decision set); writing
// one overwrites/retires rows, so we never touch a key the remote already holds.
for (const key of [
  "hitl/approvals",
  "hitl/dismissed-relationships",
  "manifest",
  "run-index",
]) {
  const value = await local.records.readJson(key);
  if (value === null) continue;
  if ((await remote.records.readJson(key)) !== null) {
    console.log(`skip record ${key} (already present remotely)`);
    continue;
  }
  await remote.records.writeJson(key, value);
  console.log(`imported record ${key}`);
}

for (const prefix of [
  "specs",
  "approved-specs",
  "candidates",
  "validation",
  "reports",
  "sessions",
  "goldens",
  "endpoint-behavior",
]) {
  const existing = new Set(await remote.blobs.list(prefix));
  let imported = 0;
  let skipped = 0;
  for (const key of await local.blobs.list(prefix)) {
    if (existing.has(key)) {
      skipped += 1;
      continue;
    }
    const bytes = await local.blobs.get(key);
    if (bytes === null) continue;
    await remote.blobs.put(key, bytes);
    imported += 1;
  }
  console.log(`${prefix}: imported ${imported} object(s), skipped ${skipped} existing`);
}

// Invariants are grained per flow; skip any flow_signature already present so a
// re-import never rewrites proposals/verification that changed remotely.
const existingFlows = new Set(
  (await remote.invariants.list()).map((row) => row.flow_signature)
);
const invariantRows = await local.invariants.list();
const invariantFlows = new Map<string, typeof invariantRows>();
for (const row of invariantRows) {
  const rows = invariantFlows.get(row.flow_signature) ?? [];
  rows.push(row);
  invariantFlows.set(row.flow_signature, rows);
}
let importedFlows = 0;
let skippedFlows = 0;
let importedInvariants = 0;
for (const [flowSignature, rows] of invariantFlows) {
  if (existingFlows.has(flowSignature)) {
    skippedFlows += 1;
    continue;
  }
  const first = rows[0];
  await remote.invariants.replaceFlow({
    flow_signature: flowSignature,
    flow_name: first.flow_name ?? flowSignature,
    cache_key: first.cache_key ?? "",
    proposed_at: first.proposed_at ?? new Date().toISOString(),
    invariants: rows,
  });
  const verified = rows.filter((row) => row.verified).map((row) => row.id);
  await remote.invariants.markVerified(verified);
  importedFlows += 1;
  importedInvariants += rows.length;
}
console.log(
  `invariants: imported ${importedInvariants} row(s) across ${importedFlows} flow(s), skipped ${skippedFlows} existing flow(s)`
);

// Older local deployments predate reports/.run-index.json. Build the structured
// index while importing so historical reports remain visible after the first new
// remote run writes its own index row — but only when the remote index is still
// empty, so we never overwrite a live index.
if ((await remote.records.readJson("run-index")) === null) {
  const reportRows: Array<Record<string, unknown>> = [];
  for (const key of await local.blobs.list("reports/runs")) {
    if (!key.endsWith(".json") || key.endsWith(".triage.json")) continue;
    const bytes = await local.blobs.get(key);
    if (bytes === null) continue;
    try {
      const report = JSON.parse(bytes.toString("utf8")) as {
        run_id?: string;
        generated_at?: string;
        status?: string;
        totals?: {
          executed?: number;
          passed?: number;
          failed?: number;
          skipped?: number;
        };
      };
      const slug = key.slice("reports/runs/".length, -".json".length);
      const totals = {
        executed: report.totals?.executed ?? 0,
        passed: report.totals?.passed ?? 0,
        failed: report.totals?.failed ?? 0,
        skipped: report.totals?.skipped ?? 0,
      };
      const status =
        report.status === "invalid" ||
        totals.executed === 0 ||
        totals.passed + totals.failed === 0
          ? "invalid"
          : report.status === "red" || totals.failed > 0
            ? "red"
            : "green";
      reportRows.push({
        run_id: report.run_id ?? slug,
        slug,
        generated_at: report.generated_at ?? null,
        status,
        totals,
      });
    } catch {
      // A malformed archived report is skipped just as the dashboard skips it.
    }
  }
  if (reportRows.length > 0) {
    await remote.records.writeJson("run-index", { entries: reportRows });
    console.log(`indexed ${reportRows.length} historical report(s)`);
  }
}
