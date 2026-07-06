/**
 * Cross-run coverage manifest + skip gate (plan section Cross-run skip gate,
 * ADR 0002). Sits between ranking and LLM naming:
 *
 *   mine -> dedup (within-run) -> rank -> [SKIP GATE] -> naming (LLM) -> candidates
 *
 * The manifest is the set of already-covered flow signatures, from two sources:
 *   1. the generated-tests corpus -- each script-generator `.spec.ts` stamps its
 *      signature (ADR 0002); we read those back.
 *   2. the HITL approval JSON store -- entries marked `approved` AND
 *      entries marked `discarded` (a human-rejected flow must not re-surface).
 *
 * TOLERANCE: a MISSING `generated-tests/` dir or a MISSING HITL
 * store is an EMPTY manifest, never an error. On a clean checkout the manifest
 * is empty and every flow is treated as new (correct by construction). All
 * filesystem access is best-effort and degrades to "nothing covered yet".
 */

import { storage, type Storage } from "../../../../packages/storage/index.js";
import type { MinedFlow } from "./dedup.js";

// Each generated test stamps its signature. The script-generator convention (ADR 0002) is
// a machine-readable marker; we match it permissively so a small format change
// in the stamp does not silently empty the manifest.
const SIGNATURE_STAMP = /flow_signature["'\s:=]+([0-9a-f]{64})/i;
// The OUTCOME half a spec asserts (`// status_signature: 200,200,401`). Lets the
// gate ask "is there already a spec for THIS outcome?", not just "for this shape".
// Older specs predating the stamp contribute a shape entry but no outcome.
const STATUS_SIGNATURE_STAMP = /status_signature["'\s:=]+([\d,]+)/i;

interface TestCoverage {
  /** Every shape that has a spec — the shape-level coverage set. */
  sigs: Set<string>;
  /** signature -> outcome(s) an actual spec asserts (from the status_signature
   * stamp). A spec predating the stamp adds to `sigs` but not here. */
  outcomes: Map<string, Set<string>>;
}

async function fromGeneratedTests(store: Storage): Promise<TestCoverage> {
  const sigs = new Set<string>();
  const outcomes = new Map<string, Set<string>>();
  const keys = (
    await Promise.all(
      ["guest", "customer", "admin"].map((persona) =>
        store.blobs.list(`specs/${persona}`)
      )
    )
  ).flat();
  for (const key of keys) {
    if (!key.endsWith(".spec.ts")) continue;
    const bytes = await store.blobs.get(key);
    if (bytes === null) continue;
    const text = bytes.toString("utf8");
    const sigMatch = SIGNATURE_STAMP.exec(text);
    if (!sigMatch) continue;
    const sig = sigMatch[1].toLowerCase();
    sigs.add(sig);
    const outMatch = STATUS_SIGNATURE_STAMP.exec(text);
    if (outMatch) {
      const set = outcomes.get(sig) ?? new Set<string>();
      set.add(outMatch[1]);
      outcomes.set(sig, set);
    }
  }
  return { sigs, outcomes };
}

interface HitlCoverage {
  /** Every decided shape (approved OR discarded) — the shape-level skip set. */
  sigs: Set<string>;
  /**
   * APPROVED shapes -> the set of blessed expected-status sequences (the
   * "outcome" half of the flow). A re-mined flow whose shape matches a key here
   * but whose outcome is NOT in the set is a drift/regression against a blessed
   * baseline, and must NOT be skipped — that is the whole point of the
   * outcome-aware gate. Entries without a `status_signature` (pre-enrichment
   * stores) contribute no outcome, so they fall back to shape-level skip.
   */
  approvedOutcomes: Map<string, Set<string>>;
  /** Every terminally reviewed outcome, including discarded and superseded versions. */
  decidedOutcomes: Map<string, Set<string>>;
}

async function fromHitlStore(store: Storage): Promise<HitlCoverage> {
  const sigs = new Set<string>();
  const approvedOutcomes = new Map<string, Set<string>>();
  const decidedOutcomes = new Map<string, Set<string>>();
  try {
    const parsed = await store.records.readJson<unknown>("hitl/approvals");
    if (parsed === null) return { sigs, approvedOutcomes, decidedOutcomes };
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
        (status === "approved" || status === "discarded" || status === "superseded")
      ) {
        const sig = signature.toLowerCase();
        sigs.add(sig);
        if (typeof entry.status_signature === "string") {
          const decided = decidedOutcomes.get(sig) ?? new Set<string>();
          decided.add(entry.status_signature);
          decidedOutcomes.set(sig, decided);
        }
        if (status === "approved" && typeof entry.status_signature === "string") {
          const set = approvedOutcomes.get(sig) ?? new Set<string>();
          set.add(entry.status_signature);
          approvedOutcomes.set(sig, set);
        }
      }
    }
  } catch {
    return { sigs, approvedOutcomes, decidedOutcomes }; // malformed -> empty
  }
  return { sigs, approvedOutcomes, decidedOutcomes };
}

export interface CoverageManifest {
  signatures: Set<string>;
  /** Approved shape -> blessed outcome(s); drives the outcome-aware skip gate. */
  approvedOutcomes: Map<string, Set<string>>;
  decidedOutcomes: Map<string, Set<string>>;
  /** Shape -> outcome(s) an ACTUAL spec already asserts. Lets the gate keep a
   * blessed outcome that has no oracle yet (so it gets generated) instead of
   * skipping it — the drift-retirement ordering fix. */
  specOutcomes: Map<string, Set<string>>;
  fromTests: number;
  fromHitl: number;
}

export interface CoverageSources {
  storage?: Storage;
}

export async function buildCoverageManifest(
  sources: CoverageSources = {}
): Promise<CoverageManifest> {
  const store = sources.storage ?? storage;
  const [tests, hitl] = await Promise.all([
    fromGeneratedTests(store),
    fromHitlStore(store),
  ]);
  const signatures = new Set<string>([...tests.sigs, ...hitl.sigs]);
  return {
    signatures,
    approvedOutcomes: hitl.approvedOutcomes,
    decidedOutcomes: hitl.decidedOutcomes,
    specOutcomes: tests.outcomes,
    fromTests: tests.sigs.size,
    fromHitl: hitl.sigs.size,
  };
}

/** The "outcome" half of a flow: its ordered expected-status sequence. MUST match
 * the dashboard's `statusSignature` (hitl-store.ts) so a blessed outcome compares
 * equal to a re-mined one. */
function outcomeOf(flow: MinedFlow): string {
  return flow.steps.map((s) => s.expected_status).join(",");
}

export interface SkipGateResult<T extends MinedFlow> {
  kept: T[];
  skipped: T[];
}

/**
 * Drop ranked flows that are already covered BEFORE the LLM call — OUTCOME-AWARE,
 * not shape-only. For a flow with shape `sig` and outcome `O`:
 *
 *   - `sig` has an APPROVED baseline:
 *       - `O` is NOT a blessed outcome        -> KEEP (drift/regression — surface it
 *                                                so the dashboard flags the conflict).
 *       - `O` IS blessed, and a spec already
 *         asserts `O`                          -> SKIP (stable; the oracle exists).
 *       - `O` IS blessed but NO spec asserts
 *         it yet                               -> KEEP (a freshly-approved drift whose
 *                                                new oracle hasn't been generated —
 *                                                keep it so the generator can emit it,
 *                                                regardless of mine/generate order).
 *   - `sig` has NO approved baseline:
 *       - shape already has a spec/decision    -> SKIP (shape-level, unchanged).
 *       - otherwise                            -> KEEP (a genuinely new journey).
 *
 * The signature deliberately excludes status (ADR 0002), so a regression shares its
 * baseline's signature; the per-outcome checks above are what let a drift through.
 * Skipped flows are returned (counted as `skipped_existing`), never silently dropped.
 */
export function applySkipGate<T extends MinedFlow>(
  rankedFlows: T[],
  manifest: CoverageManifest
): SkipGateResult<T> {
  const kept: T[] = [];
  const skipped: T[] = [];
  for (const flow of rankedFlows) {
    const outcome = outcomeOf(flow);
    const approved = manifest.approvedOutcomes.get(flow.signature);
    if (approved) {
      if (!approved.has(outcome)) {
        if (manifest.decidedOutcomes.get(flow.signature)?.has(outcome)) {
          skipped.push(flow); // already rejected/superseded outcome
        } else {
          kept.push(flow); // blessed journey, genuinely new outcome -> drift
        }
        continue;
      }
      const specced = manifest.specOutcomes.get(flow.signature);
      if (specced && specced.has(outcome)) {
        skipped.push(flow); // blessed and its oracle already exists -> stable
      } else {
        kept.push(flow); // blessed but no oracle yet -> keep so it gets generated
      }
      continue;
    }
    // No approved baseline: an exact reviewed/generated outcome is covered, but a
    // different outcome is a new review version of the same journey.
    const decided = manifest.decidedOutcomes.get(flow.signature);
    const specced = manifest.specOutcomes.get(flow.signature);
    const hasOutcomeData = Boolean(decided?.size || specced?.size);
    if (
      decided?.has(outcome) ||
      specced?.has(outcome) ||
      (!hasOutcomeData && manifest.signatures.has(flow.signature))
    ) {
      skipped.push(flow);
    } else {
      kept.push(flow);
    }
  }
  return { kept, skipped };
}
