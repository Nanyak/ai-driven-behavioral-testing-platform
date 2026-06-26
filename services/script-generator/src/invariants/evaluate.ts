/**
 * Pure invariant evaluator — the verification gate's core and the unit-test
 * oracle. Mirrors render.ts matcher-for-matcher, so "does this invariant hold
 * against body X" gives the SAME answer here (at verify time) as the rendered
 * `expect(...)` will give at run time. Used to BAKE only invariants that held on
 * a known-good response (verified === true).
 */
import type { Invariant } from "./types.js";
import { isTemplateInvariant } from "./types.js";
import { evaluateTemplate } from "./templates.js";

/** Non-throwing path reader — the in-process twin of the vendored getPath
 * (run.ts util.ts). Kept in sync deliberately so verify and runtime agree. */
export function getPath(value: unknown, path: string): unknown {
  const segments = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  let current: unknown = value;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (segment === "length" && (Array.isArray(current) || typeof current === "string")) {
      current = (current as { length: number }).length;
      continue;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export interface EvalResult {
  pass: boolean;
  actual: unknown;
}

export function evaluateInvariant(body: unknown, inv: Invariant): EvalResult {
  if (isTemplateInvariant(inv)) {
    const actual = getPath(body, inv.path);
    return { pass: evaluateTemplate(inv.template, actual), actual };
  }
  const actual = getPath(body, inv.path);
  const expected = inv.expected;
  switch (inv.matcher) {
    case "toBe":
    case "toEqual":
      return { pass: actual === expected, actual };
    case "toBeGreaterThan":
      return { pass: typeof actual === "number" && actual > Number(expected), actual };
    case "toBeGreaterThanOrEqual":
      return { pass: typeof actual === "number" && actual >= Number(expected), actual };
    case "toBeLessThan":
      return { pass: typeof actual === "number" && actual < Number(expected), actual };
    case "toBeLessThanOrEqual":
      return { pass: typeof actual === "number" && actual <= Number(expected), actual };
    case "toBeTruthy":
      return { pass: Boolean(actual), actual };
    case "toBeDefined":
      return { pass: actual !== undefined, actual };
    case "toBeUndefined":
      return { pass: actual === undefined, actual };
    case "toContain":
      if (typeof actual === "string") return { pass: actual.includes(String(expected)), actual };
      if (Array.isArray(actual)) return { pass: actual.includes(expected), actual };
      return { pass: false, actual };
    default:
      return { pass: false, actual };
  }
}

/**
 * Verify a flow's proposed invariants against a known-good run's per-step
 * response bodies (keyed by emitted step title). An invariant whose step body is
 * present AND that holds becomes `verified: true`; one that fails or has no
 * captured body stays `verified: false` (dropped at render). This is the
 * anti-hallucination bake gate: only behavior the live backend actually
 * exhibits is codified.
 */
export function verifyInvariants(
  invariants: Invariant[],
  bodiesByStep: Map<string, unknown>
): Invariant[] {
  return invariants.map((inv) => {
    if (!bodiesByStep.has(inv.stepTitle)) return { ...inv, verified: false };
    const { pass } = evaluateInvariant(bodiesByStep.get(inv.stepTitle), inv);
    return { ...inv, verified: pass };
  });
}
