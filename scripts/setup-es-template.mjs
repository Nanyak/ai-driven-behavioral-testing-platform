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
 * Run once before shipping bodies-on traffic:  npm run es:template
 * (Applying it only affects indices created afterwards — recreate the day's
 * index if it already exists with a conflicting mapping.)
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
const TEMPLATE_PATH = resolve(ROOT, "infra/elasticsearch/behavior-logs-template.json");

async function main() {
  const template = readFileSync(TEMPLATE_PATH, "utf8");

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
  console.log("✓ Installed composable index template 'behavior-logs' (response_body/request_payload as flattened).");
  console.log("  Note: applies to indices created from now on. To re-map today's index, delete it:");
  console.log(`    curl -X DELETE "${ES_URL}/behavior-logs-*"`);
  console.log("  then restart Logstash to re-ship:  docker restart <logstash-container>");
}

main().catch((e) => {
  console.error("Unexpected error:", e.message);
  process.exit(1);
});
