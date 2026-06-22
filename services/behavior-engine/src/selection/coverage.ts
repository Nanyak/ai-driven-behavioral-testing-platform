/**
 * Cross-run coverage manifest + skip gate (plan section Cross-run skip gate,
 * ADR 0002). Sits between ranking and LLM naming:
 *
 *   mine -> dedup (within-run) -> rank -> [SKIP GATE] -> naming (LLM) -> candidates
 *
 * The manifest is the set of already-covered flow signatures, from two sources:
 *   1. the generated-tests corpus -- each Phase 9 `.spec.ts` stamps its
 *      signature (ADR 0002); we read those back.
 *   2. the Phase 15 HITL approval JSON store -- entries marked `approved` AND
 *      entries marked `discarded` (a human-rejected flow must not re-surface).
 *
 * TOLERANCE (PO-6 / BA-F8): a MISSING `generated-tests/` dir or a MISSING HITL
 * store is an EMPTY manifest, never an error. On a clean checkout the manifest
 * is empty and every flow is treated as new (correct by construction). All
 * filesystem access is best-effort and degrades to "nothing covered yet".
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { MinedFlow } from "./dedup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// src/selection -> service root two up, repo root two more.
const SERVICE_ROOT = resolve(__dirname, "..", "..");
const REPO_ROOT = resolve(SERVICE_ROOT, "..", "..");

const GENERATED_TESTS_DIR = resolve(REPO_ROOT, "generated-tests");
const HITL_STORE = resolve(REPO_ROOT, "data", "hitl", "approvals.json");

// Each generated test stamps its signature. The Phase 9 convention (ADR 0002) is
// a machine-readable marker; we match it permissively so a small format change
// in the stamp does not silently empty the manifest.
const SIGNATURE_STAMP = /flow_signature["'\s:=]+([0-9a-f]{64})/i;

function listSpecFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listSpecFiles(full));
    } else if (entry.endsWith(".spec.ts")) {
      out.push(full);
    }
  }
  return out;
}

function fromGeneratedTests(dir: string): Set<string> {
  const sigs = new Set<string>();
  for (const file of listSpecFiles(dir)) {
    const match = SIGNATURE_STAMP.exec(readFileSync(file, "utf8"));
    if (match) {
      sigs.add(match[1].toLowerCase());
    }
  }
  return sigs;
}

function fromHitlStore(path: string): Set<string> {
  const sigs = new Set<string>();
  if (!existsSync(path)) {
    return sigs;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return sigs; // a malformed store is treated as empty, never fatal.
  }
  const entries = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { entries?: unknown }).entries)
      ? (parsed as { entries: unknown[] }).entries
      : [];
  for (const entry of entries as Array<Record<string, unknown>>) {
    const status = entry.status;
    const signature = entry.flow_signature ?? entry.signature;
    if (
      typeof signature === "string" &&
      (status === "approved" || status === "discarded")
    ) {
      sigs.add(signature.toLowerCase());
    }
  }
  return sigs;
}

export interface CoverageManifest {
  signatures: Set<string>;
  fromTests: number;
  fromHitl: number;
}

export interface CoverageSources {
  generatedTestsDir?: string;
  hitlStore?: string;
}

export function buildCoverageManifest(sources: CoverageSources = {}): CoverageManifest {
  const testsSigs = fromGeneratedTests(sources.generatedTestsDir ?? GENERATED_TESTS_DIR);
  const hitlSigs = fromHitlStore(sources.hitlStore ?? HITL_STORE);
  const signatures = new Set<string>([...testsSigs, ...hitlSigs]);
  return { signatures, fromTests: testsSigs.size, fromHitl: hitlSigs.size };
}

export interface SkipGateResult<T extends MinedFlow> {
  kept: T[];
  skipped: T[];
}

/**
 * Drop ranked flows whose signature is already covered BEFORE the LLM call.
 * Skipped flows are returned (counted as `skipped_existing` in the run summary),
 * never silently discarded. Generic over the flow type so a ranked/scored flow
 * keeps its extra fields through the gate.
 */
export function applySkipGate<T extends MinedFlow>(
  rankedFlows: T[],
  manifest: CoverageManifest
): SkipGateResult<T> {
  const kept: T[] = [];
  const skipped: T[] = [];
  for (const flow of rankedFlows) {
    if (manifest.signatures.has(flow.signature)) {
      skipped.push(flow);
    } else {
      kept.push(flow);
    }
  }
  return { kept, skipped };
}
