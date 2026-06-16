#!/usr/bin/env node

/**
 * Phase 5 verification: Synthetic Traffic Generator
 *
 * Confirms generated traffic reached Elasticsearch and that the session mix is
 * reflected in the logs: a spread of session_id values, user_role values
 * (guest/customer/admin), and response codes (including 4xx/5xx), plus the
 * holdout check — completed registered-customer checkouts that have no scripted
 * equivalent in flows/ (plan §8.4 / Phase 5 acceptance).
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function loadEnv() {
  const envPath = resolve(ROOT, ".env");
  if (!existsSync(envPath)) return {};
  const vars = {};
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    vars[trimmed.slice(0, eq).trim()] = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return vars;
}

const env = loadEnv();
const ES_URL = env.ELASTICSEARCH_URL || "http://localhost:9200";

let passed = 0;
let failed = 0;
const ok = (m) => (console.log(`  ✓ ${m}`), passed++);
const fail = (m, d = "") => (console.error(`  ✗ ${m}${d ? `: ${d}` : ""}`), failed++);

async function search(body) {
  const res = await fetch(`${ES_URL}/behavior-logs-*/_search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Only consider documents produced by the generator (session_id = sess-...).
const GENERATED = { prefix: { "session_id.keyword": "sess-" } };

async function checkGeneratedTraffic() {
  console.log("\n[1] Generated traffic present");
  try {
    const r = await search({ size: 0, query: GENERATED });
    const total = r?.hits?.total?.value ?? 0;
    if (total > 0) ok(`${total} generated request document(s) indexed`);
    else fail("Generated traffic indexed", "no docs with session_id prefix 'sess-' — run `npm run traffic:generate` and wait for Logstash");
    return total > 0;
  } catch (e) {
    fail("Generated traffic indexed", e.message);
    return false;
  }
}

async function checkSessionSpread() {
  console.log("\n[2] Distinct sessions");
  try {
    const r = await search({
      size: 0,
      query: GENERATED,
      aggs: { sessions: { cardinality: { field: "session_id.keyword" } } },
    });
    const count = r?.aggregations?.sessions?.value ?? 0;
    if (count >= 50) ok(`${count} distinct session_id values`);
    else if (count > 0) fail("≥50 distinct sessions", `only ${count} — generate more traffic`);
    else fail("Distinct sessions", "0");
  } catch (e) {
    fail("Distinct sessions", e.message);
  }
}

async function checkRoleSpread() {
  console.log("\n[3] user_role spread (guest / customer / admin)");
  try {
    const r = await search({
      size: 0,
      query: GENERATED,
      aggs: { roles: { terms: { field: "user_role.keyword", size: 10 } } },
    });
    const buckets = r?.aggregations?.roles?.buckets ?? [];
    const roleCounts = Object.fromEntries(buckets.map((b) => [b.key, b.doc_count]));

    // Guest traffic carries no user_role. Count null-role docs directly with a
    // must_not-exists query rather than (total − withRole): the default
    // track_total_hits cap (10000) makes total unreliable once the accumulated
    // index exceeds it, which would falsely report "no guest" traffic.
    const guestRes = await search({
      size: 0,
      query: {
        bool: {
          must: [GENERATED],
          must_not: [{ exists: { field: "user_role.keyword" } }],
        },
      },
    });
    const guest = guestRes?.hits?.total?.value ?? 0;

    if (guest > 0) ok(`guest (null role): ${guest} request(s)`);
    else fail("guest traffic", "no guest (null-role) requests found");

    const customer = roleCounts["customer"] ?? 0;
    if (customer > 0) ok(`customer role: ${customer} request(s)`);
    else fail("customer traffic", "no customer-role requests — check holdout customer checkout");

    const admin = (roleCounts["user"] ?? 0) + (roleCounts["admin"] ?? 0);
    if (admin > 0) ok(`admin role: ${admin} request(s)`);
    else fail("admin traffic", "no admin-role requests");
  } catch (e) {
    fail("user_role spread", e.message);
  }
}

async function checkResponseCodes() {
  console.log("\n[4] Response-code spread");
  try {
    const r = await search({
      size: 0,
      query: GENERATED,
      aggs: {
        codes: {
          range: {
            field: "status",
            ranges: [
              { key: "2xx", from: 200, to: 300 },
              { key: "4xx", from: 400, to: 500 },
              { key: "5xx", from: 500, to: 600 },
            ],
          },
        },
      },
    });
    const buckets = Object.fromEntries(
      (r?.aggregations?.codes?.buckets ?? []).map((b) => [b.key, b.doc_count])
    );
    if ((buckets["2xx"] ?? 0) > 0) ok(`2xx responses: ${buckets["2xx"]}`);
    else fail("2xx responses", "none — happy paths are failing");

    const errors = (buckets["4xx"] ?? 0) + (buckets["5xx"] ?? 0);
    if (errors > 0) ok(`error responses (4xx/5xx): ${errors} (edge-case coverage)`);
    else fail("error responses", "none — edge flows did not produce 4xx/5xx");
  } catch (e) {
    fail("Response-code spread", e.message);
  }
}

async function sessionsMatching(query) {
  const r = await search({
    size: 0,
    query,
    aggs: { sessions: { terms: { field: "session_id.keyword", size: 2000 } } },
  });
  return new Set((r?.aggregations?.sessions?.buckets ?? []).map((b) => b.key));
}

async function checkHoldout() {
  console.log("\n[5] Holdout: registered-customer checkouts");
  try {
    // Sessions that authenticated as a customer (semantic events).
    const customerAuth = await sessionsMatching({
      bool: {
        must: [GENERATED],
        should: [
          { term: { "event.keyword": "customer_registered" } },
          { term: { "event.keyword": "customer_logged_in" } },
          { prefix: { "endpoint.keyword": "/auth/customer" } },
        ],
        minimum_should_match: 1,
      },
    });
    // Sessions with a successful cart completion.
    const completed = await sessionsMatching({
      bool: {
        must: [
          GENERATED,
          { term: { "event.keyword": "checkout_completed" } },
          { term: { status: 200 } },
        ],
      },
    });

    const holdout = [...completed].filter((s) => customerAuth.has(s));
    if (holdout.length >= 5) {
      ok(`${holdout.length} completed registered-customer checkout(s) (null→customer→complete)`);
    } else {
      fail(
        "≥5 completed customer checkouts",
        `found ${holdout.length} — holdout may not clear PrefixSpan support`
      );
    }
  } catch (e) {
    fail("Holdout check", e.message);
  }
}

async function main() {
  console.log("Phase 5: Synthetic Traffic Generator Check");
  console.log(`  Elasticsearch: ${ES_URL}`);

  const present = await checkGeneratedTraffic();
  if (present) {
    await checkSessionSpread();
    await checkRoleSpread();
    await checkResponseCodes();
    await checkHoldout();
  }

  console.log(`\n${passed + failed} checks — ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("\nTroubleshooting:");
    console.log("  1. Generate traffic:  npm run traffic:generate");
    console.log("  2. Wait ~30s for Logstash to ship logs to Elasticsearch");
    console.log("  3. Re-run ELK check:  npm run check:phase4");
    process.exit(1);
  }
  console.log("\nAll Phase 5 checks passed.");
}

main().catch((e) => {
  console.error("Unexpected error:", e.message);
  process.exit(1);
});
