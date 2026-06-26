/**
 * Unit tests for the PURE repair modules (no live SUT, no agent). Run:
 * `npm run test:repair-guard` from this service, or
 * `npm run script-generator:test:repair` from the repo root. Plain assertions,
 * no framework — mirrors run.test.ts.
 *
 * Covers the safety-critical pieces:
 *   1. oracle-guard ACCEPTS arrange-only edits and REJECTS any oracle tampering
 *      (the anti-green-washing guarantee);
 *   2. repair-task bundles the live expected-vs-actual evidence + OAS slice.
 */
import { strict as assert } from "node:assert";
import { checkOracleUnchanged, oracleFingerprint } from "./oracle-guard.js";
import { buildRepairTask, renderRepairPrompt } from "./repair-task.js";
import type { OasSpecs } from "../resolve.js";
import type { StepOutcome } from "./verify.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const SIG = "a".repeat(64);

// A minimal but realistic emitted spec: setup handshake (arrange) + one behavioral
// step with its frozen assertion.
const baseSpec = `// flow_signature: ${SIG}
// status_signature: 200,200,200,200
// persona: admin_operator | priority: high | support: 5
import { test, expect } from "@playwright/test";
import { assertGolden } from "../../_golden/assert-golden.js";
import { extractPath, getPath, safeJson, safeText } from "../../_golden/util.js";

test("admin_operator — Admin Order Cancellation Journey", async ({ request }) => {
  test.info().annotations.push({ type: "status_signature", description: "200,200,200,200" });
  const publishableKey = process.env.MEDUSA_PUBLISHABLE_API_KEY!;
  const scope: Record<string, string> = {};
  await test.step("POST /admin/orders/{id}/cancel", async () => {
    const resolve0 = await request.get("/admin/orders?status[]=pending", { headers: { Authorization: \`Bearer \${scope.adminToken}\` } });
    expect(resolve0.status(), "resolve GET /admin/orders for orderId").toBe(200);
    scope.orderId = extractPath(await resolve0.json(), "orders[0].id");
    const resp0 = await request.post(\`/admin/orders/\${scope.orderId}/cancel\`, { headers: { Authorization: \`Bearer \${scope.adminToken}\` } });
    await test.info().attach("response-body", { body: JSON.stringify({ endpoint: "POST /admin/orders/{id}/cancel", status: resp0.status(), body: (await safeText(resp0)).slice(0, 4000) }), contentType: "application/json" });
    expect(resp0.status(), "POST /admin/orders/{id}/cancel").toBe(200);
    await assertGolden("POST /admin/orders/{id}/cancel", resp0.status(), await safeJson(resp0));
    const resp0Body = await safeJson(resp0);
    // invariant (ai-proposed): canceled order returns a canceled marker
    const resp0BodyInv0 = getPath(resp0Body, "order.canceled_at");
    expect(resp0BodyInv0, "POST /admin/orders/{id}/cancel — order.canceled_at: canceled order returns a canceled marker").toBeDefined();
  });
});
`;

// 1a. An ARRANGE-only edit (different resolver query / extra setup) is ACCEPTED.
check("oracle-guard accepts an arrange-only rewrite", () => {
  const repaired = baseSpec
    .replace(
      'request.get("/admin/orders?status[]=pending"',
      'request.post("/admin/orders", { data: {} } /* create a cancelable order */ ); const _ignore = await request.get("/admin/orders?status[]=pending&fields=*fulfillments"'
    )
    .replace('"orders[0].id"', '"orders[0].id" /* now a fresh unfulfilled order */');
  const res = checkOracleUnchanged(baseSpec, repaired);
  assert.equal(res.ok, true, `expected clean, got: ${res.violations.join("; ")}`);
});

// 1b. Changing the behavioral expected status is REJECTED (the core cheat).
check("oracle-guard rejects a changed expected status", () => {
  const cheated = baseSpec.replace(
    'expect(resp0.status(), "POST /admin/orders/{id}/cancel").toBe(200)',
    'expect(resp0.status(), "POST /admin/orders/{id}/cancel").toBe(400)'
  );
  const res = checkOracleUnchanged(baseSpec, cheated);
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((v) => v.includes("behavioral assertion")), res.violations.join("; "));
});

// 1c. Dropping a behavioral step/assertion block is REJECTED.
check("oracle-guard rejects a dropped behavioral step", () => {
  const cheated = baseSpec.replace('await test.step("POST /admin/orders/{id}/cancel"', 'await test.skip; async function _dead(');
  const res = checkOracleUnchanged(baseSpec, cheated);
  assert.equal(res.ok, false);
});

// 1d. Changing the status_signature header is REJECTED.
check("oracle-guard rejects a changed status_signature header", () => {
  const cheated = baseSpec.replace("// status_signature: 200,200,200,200", "// status_signature: 200,200,200,400");
  const res = checkOracleUnchanged(baseSpec, cheated);
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((v) => v.includes("status_signature")), res.violations.join("; "));
});

// 1e. Introducing test.fixme to neutralize the act is REJECTED.
check("oracle-guard rejects a newly introduced test.fixme", () => {
  const cheated = baseSpec.replace(
    "const scope: Record<string, string> = {};",
    "const scope: Record<string, string> = {};\n  test.fixme(true, 'todo');"
  );
  const res = checkOracleUnchanged(baseSpec, cheated);
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((v) => v.includes("neutralization")), res.violations.join("; "));
});

// 1f. Removing or altering assertGolden is REJECTED.
check("oracle-guard rejects removed or altered assertGolden calls", () => {
  const removed = baseSpec.replace(
    '    await assertGolden("POST /admin/orders/{id}/cancel", resp0.status(), await safeJson(resp0));\n',
    ""
  );
  const removedRes = checkOracleUnchanged(baseSpec, removed);
  assert.equal(removedRes.ok, false);
  assert.ok(removedRes.violations.some((v) => v.includes("golden assertion")), removedRes.violations.join("; "));

  const altered = baseSpec.replace(
    'await assertGolden("POST /admin/orders/{id}/cancel", resp0.status(), await safeJson(resp0));',
    'await assertGolden("POST /admin/orders/{id}/cancel", 400, await safeJson(resp0));'
  );
  const alteredRes = checkOracleUnchanged(baseSpec, altered);
  assert.equal(alteredRes.ok, false);
  assert.ok(alteredRes.violations.some((v) => v.includes("golden assertion")), alteredRes.violations.join("; "));
});

// 1g. Removing or altering verified business invariant assertion blocks is REJECTED.
check("oracle-guard rejects removed or altered business invariant assertions", () => {
  const removed = baseSpec.replace(
    `    // invariant (ai-proposed): canceled order returns a canceled marker
    const resp0BodyInv0 = getPath(resp0Body, "order.canceled_at");
    expect(resp0BodyInv0, "POST /admin/orders/{id}/cancel — order.canceled_at: canceled order returns a canceled marker").toBeDefined();
`,
    ""
  );
  const removedRes = checkOracleUnchanged(baseSpec, removed);
  assert.equal(removedRes.ok, false);
  assert.ok(
    removedRes.violations.some((v) => v.includes("business invariant assertion")),
    removedRes.violations.join("; ")
  );

  const altered = baseSpec.replace(
    'const resp0BodyInv0 = getPath(resp0Body, "order.canceled_at");',
    'const resp0BodyInv0 = getPath(resp0Body, "order.id");'
  );
  const alteredRes = checkOracleUnchanged(baseSpec, altered);
  assert.equal(alteredRes.ok, false);
  assert.ok(
    alteredRes.violations.some((v) => v.includes("business invariant assertion")),
    alteredRes.violations.join("; ")
  );
});

// 1h. Wrapping the oracle in try/catch is REJECTED even if the assertion text remains.
check("oracle-guard rejects new try/catch assertion neutralization", () => {
  const cheated = baseSpec
    .replace(
      'expect(resp0.status(), "POST /admin/orders/{id}/cancel").toBe(200);',
      'try {\n    expect(resp0.status(), "POST /admin/orders/{id}/cancel").toBe(200);\n    } catch (err) {}'
    );
  const res = checkOracleUnchanged(baseSpec, cheated);
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((v) => v.includes("neutralization")), res.violations.join("; "));
});

// 1i. Fingerprint surfaces status, golden, and invariant assertions.
check("oracleFingerprint captures behavioral assertion + expected", () => {
  const fp = oracleFingerprint(baseSpec);
  assert.equal(fp.statusSignature, "200,200,200,200");
  assert.deepEqual(fp.assertions, ["POST /admin/orders/{id}/cancel=>200"]);
  assert.deepEqual(fp.stepTitles, ["POST /admin/orders/{id}/cancel"]);
  assert.deepEqual(fp.goldenAssertions, [
    'await assertGolden("POST /admin/orders/{id}/cancel", resp0.status(), await safeJson(resp0));',
  ]);
  assert.deepEqual(fp.invariantAssertions, [
    "// invariant (ai-proposed): canceled order returns a canceled marker",
    'const resp0BodyInv0 = getPath(resp0Body, "order.canceled_at");',
    'expect(resp0BodyInv0, "POST /admin/orders/{id}/cancel — order.canceled_at: canceled order returns a canceled marker").toBeDefined();',
  ]);
});

// 2. repair-task bundles the live diff + a matching OAS slice into the prompt.
check("buildRepairTask + renderRepairPrompt include live evidence and OAS", () => {
  const failures: StepOutcome[] = [
    {
      endpoint: "POST /admin/orders/{id}/cancel",
      expected: 200,
      actual: 400,
      responseBody: '{"message":"Order with id ... has been canceled"}',
      failureMessage: "Expected: 200 Received: 400",
    },
  ];
  const specs: OasSpecs = {
    admin: {
      paths: { "/admin/orders/{id}/cancel": { post: { summary: "Cancel order", responses: { "200": {} } } } },
      components: { schemas: {} },
    } as unknown as OasSpecs["admin"],
    store: { paths: {}, components: { schemas: {} } } as unknown as OasSpecs["store"],
  };

  const task = buildRepairTask(
    "admin/happy-path/aaaaaaaaaaaa.spec.ts",
    "Admin Order Cancellation Journey",
    baseSpec,
    "200,200,200,200",
    failures,
    "  1) admin ... POST /admin/orders/{id}/cancel\n  Expected: 200\n  Received: 400",
    specs
  );

  assert.equal(task.oasSlices.length, 1);
  assert.equal(task.oasSlices[0].doc, "admin");
  assert.ok(task.oasSlices[0].operation, "OAS operation slice should be present");

  const prompt = renderRepairPrompt(task);
  assert.ok(prompt.includes("expected 200, got 400"), "prompt carries the live diff");
  assert.ok(prompt.includes("has been canceled"), "prompt carries the response body");
  assert.ok(prompt.includes("Cancel order"), "prompt carries the OAS slice");
  assert.ok(prompt.includes("DO NOT change any assertion"), "prompt carries the hard rules");
});

console.log(`\nrepair.test: ${passed} checks passed`);
