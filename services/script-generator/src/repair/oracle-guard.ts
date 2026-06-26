/**
 * Oracle guard (plan §New module #2) — the anti-green-washing core.
 *
 * The setup/arrange repair agent may rewrite prerequisites, path/id resolution,
 * auth sequencing, and request construction, but must NEVER touch the
 * ASSERTION/oracle. Without this, an agent told "make it pass" would cheat —
 * weaken `.toBe(200)` to `.toBe(400)`, drop a step, remove a golden/invariant
 * assertion, or change the expected outcome — silently disabling the exact
 * regression signal the suite exists to produce.
 *
 * What is immutable (the fingerprint):
 *   - the `// flow_signature:` and `// status_signature:` headers,
 *   - the test title,
 *   - the set of behavioral step titles + assertions. A BEHAVIORAL assertion is
 *     one whose label is `"<METHOD> /endpoint"` (emit.ts stamps the mined step's
 *     method+endpoint as both the `test.step` title and the `expect` label).
 *     Setup/resolve assertions use other labels ("customer register", "resolve GET
 *     … for cartId") — those are ARRANGE and the agent is free to change them.
 *   - golden assertions (`assertGolden(...)`), and verified business invariant
 *     blocks (`// invariant`, `getPath(...)`, and the labeled `expect(...)`).
 *
 * `assertOracleUnchanged` is the gate: a repaired spec whose fingerprint differs
 * from the deterministic original is REJECTED and reverted. Re-verification (a
 * real run that must go green) is the second line of defense; this guard is the
 * first, so a cheat can never even be run.
 */

export interface OracleFingerprint {
  flowSignature: string | null;
  statusSignature: string | null;
  testTitle: string | null;
  /** Behavioral `test.step` titles, sorted. */
  stepTitles: string[];
  /** Behavioral assertions as `"<label>=><expected>"`, sorted. */
  assertions: string[];
  /** Golden-response assertions, normalized statement text, sorted. */
  goldenAssertions: string[];
  /** Verified business invariant assertion blocks, normalized statement text, sorted. */
  invariantAssertions: string[];
}

const FLOW_SIG = /^\/\/ flow_signature:\s*([0-9a-f]{64})/m;
const STATUS_SIG = /^\/\/ status_signature:\s*([\d,]+)/m;
const TEST_TITLE = /\btest\(\s*("(?:[^"\\]|\\.)*")\s*,/;
const STEP_TITLE = /\btest\.step\(\s*"((?:GET|POST|PUT|PATCH|DELETE) \/[^"]*)"/g;
const BEHAVIORAL_ASSERT =
  /\bexpect\(\s*\w+\.status\(\)\s*,\s*"((?:GET|POST|PUT|PATCH|DELETE) \/[^"]*)"\s*\)\.toBe\(\s*(\d+)\s*\)/g;
const ASSERT_GOLDEN = /^\s*await\s+assertGolden\([^\n;]*\);\s*$/gm;
const INVARIANT_COMMENT = /^\s*\/\/ invariant \([^)]+\):.*$/gm;
const INVARIANT_GET_PATH = /^\s*const\s+\w+\s*=\s*getPath\([^\n;]*\);\s*$/gm;
const INVARIANT_EXPECT =
  /^\s*expect\([^\n;]*,\s*"(?:[^"\\]|\\.)*(?:—|\\u2014)(?:[^"\\]|\\.)*"\)\.\w+\([^\n;]*\);\s*$/gm;
// Structural neutralizations a repair must never introduce (swallow/skip the act).
const FORBIDDEN_IF_NEW = [/\btest\.skip\(/, /\btest\.fixme\(/, /\btry\s*{/, /\bcatch\s*(?:\(|{)/];

function matchAllGroup(source: string, re: RegExp, ...groups: number[]): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(re)) {
    out.push(groups.map((g) => m[g]).join("=>"));
  }
  return out.sort();
}

function normalizeStatement(statement: string): string {
  return statement.trim().replace(/\s+/g, " ");
}

function matchAllStatements(source: string, re: RegExp): string[] {
  return [...source.matchAll(re)].map((m) => normalizeStatement(m[0])).sort();
}

export function oracleFingerprint(source: string): OracleFingerprint {
  return {
    flowSignature: FLOW_SIG.exec(source)?.[1] ?? null,
    statusSignature: STATUS_SIG.exec(source)?.[1] ?? null,
    testTitle: TEST_TITLE.exec(source)?.[1] ?? null,
    stepTitles: matchAllGroup(source, STEP_TITLE, 1),
    assertions: matchAllGroup(source, BEHAVIORAL_ASSERT, 1, 2),
    goldenAssertions: matchAllStatements(source, ASSERT_GOLDEN),
    invariantAssertions: [
      ...matchAllStatements(source, INVARIANT_COMMENT),
      ...matchAllStatements(source, INVARIANT_GET_PATH),
      ...matchAllStatements(source, INVARIANT_EXPECT),
    ].sort(),
  };
}

export interface OracleCheck {
  ok: boolean;
  violations: string[];
}

/**
 * Compare the repaired spec's oracle against the original's. Returns the list of
 * violations (empty = clean). Callers MUST revert to the original on any violation.
 */
export function checkOracleUnchanged(original: string, repaired: string): OracleCheck {
  const a = oracleFingerprint(original);
  const b = oracleFingerprint(repaired);
  const violations: string[] = [];

  if (a.flowSignature !== b.flowSignature)
    violations.push(`flow_signature changed: ${a.flowSignature} -> ${b.flowSignature}`);
  if (a.statusSignature !== b.statusSignature)
    violations.push(`status_signature changed: ${a.statusSignature} -> ${b.statusSignature}`);
  if (a.testTitle !== b.testTitle) violations.push(`test title changed: ${a.testTitle} -> ${b.testTitle}`);

  const setDiff = (label: string, before: string[], after: string[]): void => {
    const bset = new Set(after);
    const aset = new Set(before);
    const removed = before.filter((x) => !bset.has(x));
    const added = after.filter((x) => !aset.has(x));
    if (removed.length) violations.push(`${label} removed/altered: ${removed.join(", ")}`);
    if (added.length) violations.push(`${label} added/altered: ${added.join(", ")}`);
  };
  setDiff("behavioral step", a.stepTitles, b.stepTitles);
  setDiff("behavioral assertion", a.assertions, b.assertions);
  setDiff("golden assertion", a.goldenAssertions, b.goldenAssertions);
  setDiff("business invariant assertion", a.invariantAssertions, b.invariantAssertions);

  for (const re of FORBIDDEN_IF_NEW) {
    if (re.test(repaired) && !re.test(original)) {
      violations.push(`introduced a forbidden neutralization (${re.source})`);
    }
  }

  return { ok: violations.length === 0, violations };
}
