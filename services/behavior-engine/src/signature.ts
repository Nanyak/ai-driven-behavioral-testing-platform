/**
 * Stable flat import surface for the cross-run flow signature (ADR 0002).
 *
 * The implementation moved under `signature/` in the behavior-engine refactor,
 * but the script-generator (dedup.ts) imports `canonicalTokens`/`SignatureStep`
 * from this root path. Barrel kept so the move stays internal to the engine and
 * that consumer does not break.
 */
export * from "./signature/signature.js";
