#!/usr/bin/env node

/**
 * Installs the `behavior-logs` composable index template into Elasticsearch.
 *
 * Why this exists: with LOG_CAPTURE_BODIES=true (recommended for Phase 5 so
 * bodies reach the logs for golden extraction), `response_body` and
 * `request_payload` are free-form JSON whose shape varies per endpoint. Under
 * dynamic mapping that produces type conflicts (a field that is an object in
 * one response and a scalar in another) and Elasticsearch rejects those docs
 * with HTTP 400. Mapping these blob fields as `flattened` stores arbitrary
 * nested JSON as a single field with keyword leaves — no conflicts, no field
 * explosion. The Phase 6/8 golden extractor reads them from `_source`.
 *
 * Compose installs this automatically through `elasticsearch-init`. Run
 * `npm run es:template` when operating Elasticsearch outside Compose.
 * Mapping changes affect indices created afterwards; ILM is also attached to
 * existing behavior-log indices.
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
const ES_URL =
  process.env.ELASTICSEARCH_URL || env.ELASTICSEARCH_URL || "http://localhost:9200";
const TEMPLATE_PATH = resolve(ROOT, "infra/elasticsearch/behavior-logs-template.json");
const ILM_POLICY_PATH = resolve(ROOT, "infra/elasticsearch/behavior-logs-ilm-policy.json");

async function main() {
  const policy = readFileSync(ILM_POLICY_PATH, "utf8");
  const template = readFileSync(TEMPLATE_PATH, "utf8");

  const putPolicy = await fetch(`${ES_URL}/_ilm/policy/behavior-logs-retention`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: policy,
    signal: AbortSignal.timeout(10000),
  });
  if (!putPolicy.ok) {
    console.error(`✗ Failed to install ILM policy: HTTP ${putPolicy.status}`);
    console.error(await putPolicy.text());
    process.exit(1);
  }

  const put = await fetch(`${ES_URL}/_index_template/behavior-logs`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: template,
    signal: AbortSignal.timeout(10000),
  });

  if (!put.ok) {
    console.error(`✗ Failed to install template: HTTP ${put.status}`);
    console.error(await put.text());
    process.exit(1);
  }
  const updateExisting = await fetch(
    `${ES_URL}/behavior-logs-*/_settings?allow_no_indices=true`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ "index.lifecycle.name": "behavior-logs-retention" }),
      signal: AbortSignal.timeout(10000),
    }
  );
  if (!updateExisting.ok) {
    console.error(`✗ Failed to apply ILM policy to existing indices: HTTP ${updateExisting.status}`);
    console.error(await updateExisting.text());
    process.exit(1);
  }
  console.log("✓ Installed 7-day ILM retention and the composable 'behavior-logs' index template.");
  console.log("  Mapping changes apply to new indices. To re-map today's index, delete it:");
  console.log(`    curl -X DELETE "${ES_URL}/behavior-logs-*"`);
  console.log("  then restart Logstash to re-ship:  docker restart <logstash-container>");
}

main().catch((e) => {
  console.error("Unexpected error:", e.message);
  process.exit(1);
});
