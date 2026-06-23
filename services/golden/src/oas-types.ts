/**
 * Stable flat import surface for the minimal OpenAPI types. Implementation
 * lives under `oas/`; consumers (script-generator resolve.ts/run.ts,
 * test-runner triage) import `OasDocument`/`OasSchema`/`isRefSchema` etc. from
 * this root path. Barrel kept so the refactor stays internal to golden.
 */
export * from "./oas/oas-types.js";
