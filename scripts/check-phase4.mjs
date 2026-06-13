#!/usr/bin/env node

/**
 * Phase 4 verification: ELK Integration
 * Checks Elasticsearch health, Kibana availability, index existence, and field filterability.
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// Load root .env
function loadEnv() {
  const envPath = resolve(ROOT, ".env");
  if (!existsSync(envPath)) return {};
  const vars = {};
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    vars[key] = val;
  }
  return vars;
}

const env = loadEnv();
const ES_URL = env.ELASTICSEARCH_URL || "http://localhost:9200";
const KIBANA_URL = env.KIBANA_URL || "http://localhost:5601";

let passed = 0;
let failed = 0;

function ok(msg) {
  console.log(`  ✓ ${msg}`);
  passed++;
}

function fail(msg, detail = "") {
  console.error(`  ✗ ${msg}${detail ? `: ${detail}` : ""}`);
  failed++;
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000), ...opts });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function checkElasticsearch() {
  console.log("\n[1] Elasticsearch");
  try {
    const { status, body } = await fetchJson(`${ES_URL}/_cluster/health`);
    if (status !== 200) {
      fail("Elasticsearch reachable", `HTTP ${status}`);
      return false;
    }
    ok("Elasticsearch reachable");
    const health = body?.status;
    if (health === "green" || health === "yellow") {
      ok(`Cluster health: ${health}`);
    } else {
      fail("Cluster health", health ?? "unknown");
    }
    return true;
  } catch (e) {
    fail("Elasticsearch reachable", e.message);
    return false;
  }
}

async function checkKibana() {
  console.log("\n[2] Kibana");
  try {
    const { status } = await fetchJson(`${KIBANA_URL}/api/status`);
    if (status === 200 || status === 503) {
      ok("Kibana reachable");
    } else {
      fail("Kibana reachable", `HTTP ${status}`);
    }
  } catch (e) {
    fail("Kibana reachable", e.message);
  }
}

async function checkIndex() {
  console.log("\n[3] behavior-logs-* index");
  try {
    const { status, body } = await fetchJson(`${ES_URL}/behavior-logs-*`);
    if (status !== 200 || !body || Object.keys(body).length === 0) {
      fail("behavior-logs-* index exists", status === 404 ? "not found — wait for Logstash to ship logs" : `HTTP ${status}`);
      return false;
    }
    const indexNames = Object.keys(body).join(", ");
    ok(`Index exists: ${indexNames}`);
    return true;
  } catch (e) {
    fail("behavior-logs-* index exists", e.message);
    return false;
  }
}

async function checkDocuments() {
  console.log("\n[4] Document count");
  try {
    const { status, body } = await fetchJson(`${ES_URL}/behavior-logs-*/_count`);
    if (status !== 200) {
      fail("Documents indexed", `HTTP ${status}`);
      return false;
    }
    const count = body?.count ?? 0;
    if (count > 0) {
      ok(`${count} document(s) indexed`);
      return true;
    } else {
      fail("Documents indexed", "count is 0 — wait for Logstash to process the log file");
      return false;
    }
  } catch (e) {
    fail("Documents indexed", e.message);
    return false;
  }
}

async function checkFilter(field, label) {
  try {
    const query = {
      query: { exists: { field } },
      size: 1,
      _source: [field],
    };
    const { status, body } = await fetchJson(`${ES_URL}/behavior-logs-*/_search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(query),
    });
    if (status !== 200) {
      fail(`Filter by ${label}`, `HTTP ${status}`);
      return;
    }
    const total = body?.hits?.total?.value ?? 0;
    if (total > 0) {
      const sample = body?.hits?.hits?.[0]?._source?.[field];
      ok(`Filter by ${label} works (${total} docs, sample: ${JSON.stringify(sample)})`);
    } else {
      fail(`Filter by ${label}`, `field "${field}" not present in any document`);
    }
  } catch (e) {
    fail(`Filter by ${label}`, e.message);
  }
}

async function checkFilters() {
  console.log("\n[5] Field filters");
  await checkFilter("session_id", "session_id");
  await checkFilter("user_role", "user_role");
  await checkFilter("status", "status (response code)");
}

async function main() {
  console.log("Phase 4: ELK Integration Check");
  console.log(`  Elasticsearch: ${ES_URL}`);
  console.log(`  Kibana:        ${KIBANA_URL}`);

  const esOk = await checkElasticsearch();
  await checkKibana();

  if (esOk) {
    const indexOk = await checkIndex();
    if (indexOk) {
      const docsOk = await checkDocuments();
      if (docsOk) {
        await checkFilters();
      }
    }
  }

  console.log(`\n${passed + failed} checks — ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.log("\nTroubleshooting:");
    console.log("  1. Start ELK:       npm run elk:up");
    console.log("  2. Wait ~60s for Elasticsearch to initialize");
    console.log("  3. Ensure Medusa has produced logs: npm run compose:up");
    console.log("  4. Check Logstash:  npm run elk:logs");
    process.exit(1);
  }

  console.log("\nAll checks passed. Open Kibana at " + KIBANA_URL);
  console.log("  Stack Management → Index Patterns → behavior-logs-* (time field: @timestamp)");
}

main().catch((e) => {
  console.error("Unexpected error:", e.message);
  process.exit(1);
});
