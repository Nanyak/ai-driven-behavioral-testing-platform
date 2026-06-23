/**
 * Canonical flow signature — the ONE definition of "is this the same flow?".
 *
 * ADR 0002: this function is the single source of the flow signature. Three
 * consumers call it and must never recompute it divergently:
 *   - dedup.ts            (within-run identical-sequence collapse)
 *   - the cross-run skip gate / coverage.ts
 *   - script-generator/emit.ts (stamped into each generated test)
 *
 * The signature is a stable hash of the NORMALIZED STEP SEQUENCE: the ordered
 * list of `METHOD normalized_endpoint` tokens. Two rules are load-bearing and
 * must stay stable (changing either re-keys every signature, ADR 0002):
 *
 *   1. Persona is NOT part of the key. Identity is the endpoint sequence, not
 *      its derived label (ADR 0002).
 *   2. STATUS is NOT part of the key. The key is method + endpoint only.
 *   3. Consecutive identical tokens collapse to one. A 200/304
 *      revalidation pair, or any back-to-back repeat of the same
 *      `METHOD endpoint`, is a no-op repeat and must not split an otherwise
 *      identical flow into two signatures. This collapse is applied here, once,
 *      so dedup / skip-gate / emit all see the same canonical token list.
 *
 * Endpoints are assumed already normalized by ingestion (`/store/carts/{id}/
 * line-items`, not a concrete id). We do not re-normalize here — normalization
 * lives in the ingestion pipeline (ADR 0002, log-ingestion/pipeline.ts).
 */

import { createHash } from "node:crypto";

/** Minimal step shape the signature reads. Status is deliberately absent. */
export interface SignatureStep {
  method: string;
  endpoint: string;
}

function tokenOf(step: SignatureStep): string {
  return `${step.method.toUpperCase()} ${step.endpoint}`;
}

/**
 * The canonical token list for a flow: `METHOD endpoint` tokens with consecutive
 * duplicates collapsed (rule 3). Exposed so dedup/clustering can compare and hash
 * the same canonical form the signature is built from.
 */
export function canonicalTokens(steps: SignatureStep[]): string[] {
  const tokens: string[] = [];
  for (const step of steps) {
    const token = tokenOf(step);
    if (tokens.length === 0 || tokens[tokens.length - 1] !== token) {
      tokens.push(token);
    }
  }
  return tokens;
}

/**
 * Stable signature for a flow. SHA-256 over the newline-joined canonical token
 * list. Empty step lists hash to a fixed sentinel so the function is total.
 */
export function flowSignature(steps: SignatureStep[]): string {
  const tokens = canonicalTokens(steps);
  const body = tokens.join("\n");
  return createHash("sha256").update(body).digest("hex");
}
