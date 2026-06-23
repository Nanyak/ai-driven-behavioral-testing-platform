/**
 * Stable flat import surface for the OAS resolver/loader. Implementation lives
 * under `oas/`; the script-generator (run.ts) imports `loadAugmentedSpecs` from
 * this root path. Barrel kept so the refactor stays internal to golden.
 */
export * from "./oas/oas-source.js";
