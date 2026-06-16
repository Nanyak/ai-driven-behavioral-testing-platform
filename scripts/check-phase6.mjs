#!/usr/bin/env node

/**
 * Phase 6 verification: Data Ingestion Service
 *
 * Validates the latest ingestion artifact under data/sessions/ against the
 * plan's acceptance bullets: ≥50 session flows, steps grouped by session and
 * ordered by timestamp, dynamic IDs normalized (no raw cart/product ids, `{id}`
 * present), noise endpoints (e.g. /health) absent, and role_observed present
 * (documented as validation-only). Golden candidates are checked when present
 * (bodies-off runs legitimately produce none — ADR 0001).
 *
 * Reads the produced output, so it needs no running ELK stack. Run an ingestion
 * first:  npm run ingest:run -- --file logs/medusa-json.log --from <iso>
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SESSIONS_DIR = resolve(ROOT, "data", "sessions");
const GOLDEN_DIR = resolve(ROOT, "golden-responses");

let passed = 0;
let failed = 0;
const ok = (m) => (console.log(`  ✓ ${m}`), passed++);
const fail = (m, d = "") => (console.error(`  ✗ ${m}${d ? `: ${d}` : ""}`), failed++);

function latestSessionsFile() {
  if (!existsSync(SESSIONS_DIR)) return null;
  const files = readdirSync(SESSIONS_DIR)
    .filter((f) => f.startsWith("session-flows-") && f.endsWith(".json"))
    .sort();
  return files.length ? resolve(SESSIONS_DIR, files[files.length - 1]) : null;
}

const RAW_ID = /\/(?:[a-z]+_[a-zA-Z0-9_]+|[0-9a-f]{24,}|\d+)$/i;

function main() {
  console.log("Phase 6: Data Ingestion Service Check");

  const file = latestSessionsFile();
  if (!file) {
    fail("Ingestion output present", "no session-flows-*.json in data/sessions — run `npm run ingest:run`");
    summary();
    return;
  }
  console.log(`  artifact: ${file}\n`);

  let sessions;
  try {
    sessions = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    fail("Output is valid JSON", e.message);
    summary();
    return;
  }

  console.log("[1] Session-flow records");
  if (Array.isArray(sessions) && sessions.length >= 50) ok(`${sessions.length} session flows (≥50)`);
  else fail("≥50 session flows", `found ${Array.isArray(sessions) ? sessions.length : "non-array"}`);

  console.log("\n[2] Grouping + chronological order");
  let unordered = 0;
  let multiStep = 0;
  for (const s of sessions) {
    if (s.steps.length > 1) multiStep++;
    for (let i = 1; i < s.steps.length; i++) {
      if (s.steps[i - 1].timestamp > s.steps[i].timestamp) unordered++;
    }
  }
  if (unordered === 0) ok("every session's steps are timestamp-ordered");
  else fail("steps timestamp-ordered", `${unordered} out-of-order step pair(s)`);
  if (multiStep > 0) ok(`${multiStep} multi-step session(s) to mine`);
  else fail("multi-step sessions", "none — nothing to mine");

  console.log("\n[3] Endpoint normalization");
  let rawIds = 0;
  let withPlaceholder = 0;
  let noise = 0;
  for (const s of sessions) {
    for (const step of s.steps) {
      if (RAW_ID.test(step.endpoint)) rawIds++;
      if (step.endpoint.includes("{id}")) withPlaceholder++;
      if (step.endpoint === "/health" || step.endpoint === "/" || step.endpoint.startsWith("/health/")) noise++;
    }
  }
  if (rawIds === 0) ok("no raw dynamic IDs in endpoints");
  else fail("dynamic IDs normalized", `${rawIds} endpoint(s) still carry a raw id`);
  if (withPlaceholder > 0) ok(`${withPlaceholder} normalized {id} segment(s) present`);
  else fail("{id} placeholders present", "none — normalization may not be running");
  if (noise === 0) ok("noise endpoints (/health, /) absent from steps");
  else fail("noise removed", `${noise} noise step(s) leaked`);

  console.log("\n[4] role_observed (validation ground truth only)");
  const missingRole = sessions.filter((s) => !Array.isArray(s.role_observed) || s.role_observed.length === 0).length;
  if (missingRole === 0) ok("every session carries role_observed");
  else fail("role_observed present", `${missingRole} session(s) missing it`);
  const noPersona = sessions.every((s) => !("persona" in s));
  if (noPersona) ok("no persona field written (label-free by design)");
  else fail("label-free output", "a persona field was written — ingestion must stay unlabeled");

  console.log("\n[5] Golden candidates");
  const goldens = existsSync(GOLDEN_DIR)
    ? readdirSync(GOLDEN_DIR).filter((f) => f.endsWith(".json"))
    : [];
  if (goldens.length > 0) ok(`${goldens.length} golden candidate file(s) written`);
  else ok("no golden candidates (bodies-off run — Phase 8 uses spec-only, expected)");

  summary();
}

function summary() {
  console.log(`\n${passed + failed} checks — ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("\nTroubleshooting:");
    console.log("  1. Run ingestion:  npm run ingest:run -- --file logs/medusa-json.log --from 2026-06-01T00:00:00Z");
    console.log("  2. Or against ELK:  npm run elk:up  then  npm run ingest:run");
    process.exit(1);
  }
  console.log("\nAll Phase 6 checks passed.");
}

main();
