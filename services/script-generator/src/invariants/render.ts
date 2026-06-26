/**
 * Render verified invariants (types.ts) into a step's emitted body — the layer
 * that turns "the status was 200" into "the BEHAVIOR held". Called by emit.ts
 * AFTER the status assertion (and golden), so a status drift still fails first
 * and an invariant only adds signal on top of a structurally-correct response.
 *
 * Each invariant becomes one deterministic `expect(getPath(body, "<path>"))`
 * call. The value is read with `getPath` (the non-throwing reader vendored into
 * _golden/util.ts) so a missing path surfaces as a clean assertion failure
 * (`undefined` did not satisfy the matcher) rather than a thrown TypeError that
 * would mask the regression.
 */
import type { Invariant } from "./types.js";
import { NULLARY_MATCHERS } from "./types.js";

function literal(value: string | number | boolean): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/** A short, debuggable label: the step + path + the human rationale. */
function label(inv: Invariant): string {
  return `${inv.stepTitle} — ${inv.path}: ${inv.rationale}`;
}

/**
 * Emit the invariant block for a single step. `bodyVar` is the name of an
 * in-scope const already holding the parsed JSON body (emit declares it once per
 * step). Returns "" when there are no invariants, so emit can skip the read.
 */
export function renderInvariants(bodyVar: string, invariants: Invariant[]): string {
  if (invariants.length === 0) return "";
  const lines: string[] = [];
  invariants.forEach((inv, i) => {
    const valueVar = `${bodyVar}Inv${i}`;
    lines.push(`    // invariant (${inv.source}): ${inv.rationale}`);
    lines.push(`    const ${valueVar} = getPath(${bodyVar}, ${JSON.stringify(inv.path)});`);
    if (NULLARY_MATCHERS.has(inv.matcher)) {
      lines.push(`    expect(${valueVar}, ${JSON.stringify(label(inv))}).${inv.matcher}();`);
    } else {
      lines.push(
        `    expect(${valueVar}, ${JSON.stringify(label(inv))}).${inv.matcher}(${literal(inv.expected as string | number | boolean)});`
      );
    }
  });
  return lines.join("\n");
}
