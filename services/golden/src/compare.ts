/**
 * Stable flat import surface for the golden comparator.
 *
 * The implementation lives under `compare/` (split out in the golden-service
 * refactor), but cross-service consumers — services/test-runner (collect.ts,
 * failure.ts, report/schema.ts) and the script-generator's VENDORED
 * `_golden/assert-golden.ts` (`import { compareResponse } from "./compare.js"`)
 * — import it from this root path. Keep this barrel so the move stays internal
 * to the golden service and those import sites (and the vendored runtime) do
 * not break.
 */
export * from "./compare/compare.js";
