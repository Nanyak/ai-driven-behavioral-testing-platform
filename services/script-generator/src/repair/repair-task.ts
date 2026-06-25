/**
 * Repair task assembly (plan §New module #3). Bundles everything the agent needs
 * to fix ONE failing spec's arrange/setup so it reproduces the mined outcome:
 *   - the current (deterministic) spec source,
 *   - the immutable expected `status_signature`,
 *   - per-step expected-vs-actual + the captured response body (the live evidence
 *     of WHY the precondition wasn't met),
 *   - the Playwright failure tail,
 *   - OAS request/response slices for the flow's endpoints (so the agent knows
 *     what a valid arrange request looks like without guessing).
 *
 * The prompt's rules are the contract the oracle-guard enforces mechanically: only
 * arrange/setup may change; assertions, expected statuses, step set, and signatures
 * are frozen; ids are runtime-resolved, never hardcoded (CLAUDE.md §5).
 */
import type { OasDocument, OasMethod } from "../../../golden/src/oas-types.js";
import type { OasSpecs } from "../resolve.js";
import type { StepOutcome } from "./verify.js";

export interface OasSlice {
  method: string;
  endpoint: string;
  doc: "store" | "admin";
  /** The OAS path-item operation, JSON-trimmed; null when the path isn't documented. */
  operation: unknown | null;
}

/** Live SUT connection info so the agent can explore read-only (curl) for state. */
export interface SutInfo {
  baseUrl: string;
  adminEmail: string;
  adminPassword: string;
  publishableKey: string;
}

export interface RepairTask {
  relPath: string;
  flowName: string;
  expectedSignature: string | null;
  specSource: string;
  failures: StepOutcome[];
  stdoutTail: string;
  oasSlices: OasSlice[];
  sut?: SutInfo;
}

const STEP_TITLE = /\btest\.step\(\s*"((GET|POST|PUT|PATCH|DELETE)) (\/[^"]*)"/g;

/** Endpoints (method + path) the spec exercises, in first-seen order. */
function endpointsOf(source: string): { method: string; endpoint: string }[] {
  const seen = new Set<string>();
  const out: { method: string; endpoint: string }[] = [];
  for (const m of source.matchAll(STEP_TITLE)) {
    const key = `${m[2]} ${m[3]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ method: m[2], endpoint: m[3] });
  }
  return out;
}

function operationSlice(doc: OasDocument, method: string, endpoint: string): unknown | null {
  const op = doc.paths[endpoint]?.[method.toLowerCase() as OasMethod];
  return op ?? null;
}

/** Pull the OAS operation for each endpoint from whichever doc (store/admin) has it. */
function oasSlicesFor(source: string, specs: OasSpecs): OasSlice[] {
  const slices: OasSlice[] = [];
  for (const { method, endpoint } of endpointsOf(source)) {
    const adminOp = operationSlice(specs.admin, method, endpoint);
    const storeOp = operationSlice(specs.store, method, endpoint);
    if (adminOp) slices.push({ method, endpoint, doc: "admin", operation: adminOp });
    else if (storeOp) slices.push({ method, endpoint, doc: "store", operation: storeOp });
    else slices.push({ method, endpoint, doc: endpoint.startsWith("/admin/") ? "admin" : "store", operation: null });
  }
  return slices;
}

export function buildRepairTask(
  relPath: string,
  flowName: string,
  specSource: string,
  expectedSignature: string | null,
  failures: StepOutcome[],
  stdoutTail: string,
  specs: OasSpecs,
  sut?: SutInfo
): RepairTask {
  return {
    relPath,
    flowName,
    expectedSignature,
    specSource,
    failures,
    stdoutTail,
    oasSlices: oasSlicesFor(specSource, specs),
    sut,
  };
}

const RULES = `You are repairing a generated Playwright API test so it reproduces a mined behavior.

The test SELECTS pre-existing entities (e.g. \`orders[0]\`) that may be in the wrong
state, so a step that the behavior-engine observed returning 200 now returns a 4xx.
Your job: rewrite ONLY the ARRANGE / SETUP so the entity is in the state that makes
the asserted statuses hold.

PREFER selecting an existing entity that is ALREADY in the required state over
creating one from scratch (creation via the admin API is often multi-step and
fragile). List with the fields you need to judge state, then pick the first that
qualifies — fall back to the next page / a broader query if none do. Examples:
- cancel needs an order that is NOT canceled AND has NO fulfillments: request
  \`GET /admin/orders?order=-created_at&limit=50&fields=id,status,canceled_at,*fulfillments\`,
  then \`orders.find(o => !o.canceled_at && (o.fulfillments?.length ?? 0) === 0)\`.
- assert the picked id is non-null before the act so a bad arrange fails loudly.

HARD RULES (a violation makes your output rejected unread):
1. DO NOT change any assertion. Every \`expect(resp.status(), "<METHOD> /endpoint>").toBe(N)\`
   line, its expected status N, the \`test.step("<METHOD> /endpoint>", ...)\` titles, the
   test title, and the \`// flow_signature\` / \`// status_signature\` headers are FROZEN.
2. DO NOT add \`test.skip\`, \`test.fixme\`, or wrap a behavioral assertion in try/catch to
   swallow it. The test must genuinely pass by arranging real state.
3. Never hardcode a seeded id. Resolve every id at runtime from a prior response.
4. Keep it a single self-contained spec file. Use only \`request\`, \`expect\`, \`scope\`,
   and the existing imports. Auth: admin via \`scope.adminToken\`, customer via
   \`scope.customerToken\`, both already established in setup.

You MAY explore the live API read-only with \`curl\` to discover the right arrange
(e.g. which orders are actually cancelable) BEFORE writing the spec. Use GET
requests only — do not mutate state during exploration. When done exploring,
output ONLY the full rewritten spec file as your final message, no markdown fences,
no commentary.`;

/** A curl-exploration crib so the agent can authenticate + probe the live SUT. */
function explorationSection(sut: NonNullable<RepairTask["sut"]>): string {
  return `## Live SUT (explore read-only with curl, GET only)
Base URL: ${sut.baseUrl}
Get an admin token:
  curl -s -X POST ${sut.baseUrl}/auth/user/emailpass -H 'content-type: application/json' \\
    -d '{"email":"${sut.adminEmail}","password":"${sut.adminPassword}"}'
  # -> { "token": "<JWT>" }; then pass  -H "Authorization: Bearer <JWT>"  to /admin/* GETs.
Store publishable key (for /store/* if needed): ${sut.publishableKey || "(unset)"}
Probe entity state to find one in the REQUIRED condition, then encode that selection
in the spec's arrange (resolve the id at runtime exactly as you discovered it).`;
}

/** Render the task into the prompt fed to the agent. */
export function renderRepairPrompt(task: RepairTask): string {
  const failureLines = task.failures.length
    ? task.failures
        .map(
          (f) =>
            `- ${f.endpoint}: expected ${f.expected}, got ${f.actual}\n  response: ${(
              f.responseBody ?? ""
            ).slice(0, 600)}`
        )
        .join("\n")
    : "(no per-step diff captured — see Playwright output below)";

  const oasLines = task.oasSlices
    .map(
      (s) =>
        `### ${s.method} ${s.endpoint} (${s.doc})\n${
          s.operation ? JSON.stringify(s.operation, null, 1).slice(0, 1500) : "(not documented in OAS)"
        }`
    )
    .join("\n\n");

  return [
    RULES,
    `\n## Flow: ${task.flowName}`,
    `Expected status sequence (status_signature): ${task.expectedSignature ?? "(unknown)"}`,
    `\n## Failing steps (live evidence)\n${failureLines}`,
    `\n## Playwright output (tail)\n${task.stdoutTail.slice(-2500)}`,
    task.sut ? `\n${explorationSection(task.sut)}` : "",
    `\n## OAS slices for the flow's endpoints\n${oasLines}`,
    `\n## Current spec (rewrite its arrange/setup only)\n${task.specSource}`,
  ].join("\n");
}
