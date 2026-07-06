import { makeLocalStorage } from "./local.js";
import { makeRemoteStorage } from "./remote.js";

const local = makeLocalStorage();
const remote = makeRemoteStorage();

for (const key of [
  "hitl/approvals",
  "hitl/dismissed-relationships",
  "manifest",
  "run-index",
]) {
  const value = await local.records.readJson(key);
  if (value !== null) {
    await remote.records.writeJson(key, value);
    console.log(`imported record ${key}`);
  }
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
  let count = 0;
  for (const key of await local.blobs.list(prefix)) {
    const bytes = await local.blobs.get(key);
    if (bytes !== null) {
      await remote.blobs.put(key, bytes);
      count += 1;
    }
  }
  console.log(`imported ${count} ${prefix} object(s)`);
}

const invariantRows = await local.invariants.list();
const invariantFlows = new Map<string, typeof invariantRows>();
for (const row of invariantRows) {
  const rows = invariantFlows.get(row.flow_signature) ?? [];
  rows.push(row);
  invariantFlows.set(row.flow_signature, rows);
}
for (const [flowSignature, rows] of invariantFlows) {
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
}
console.log(`imported ${invariantRows.length} invariant row(s)`);

// Older local deployments predate reports/.run-index.json. Build the structured
// index while importing so historical reports remain visible after the first new
// remote run writes its own index row.
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
