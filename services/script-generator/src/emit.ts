// Filenames are derived from the candidate's signature (ADR 0002), not an
// index, so regeneration is idempotent — handled by the caller (run.ts), not here.
import type { Candidate } from "./load.js";
import type { AuthRequirement, BodyPlan, FlowPlan, ResolveCall, StepPlan, SynthesizedBody } from "./resolve.js";
import { renderInvariants } from "./invariants/render.js";
import type { Invariant } from "./invariants/types.js";
import { isTemplateInvariant } from "./invariants/types.js";
import { templateImportNames } from "./invariants/templates.js";

export interface EmitResult {
  source: string;
  fixmeCount: number;
}

function authHeaderExpr(auth: AuthRequirement): string {
  switch (auth) {
    case "publishable-key":
      return `{ "x-publishable-api-key": publishableKey }`;
    case "customer-token":
      return `{ "x-publishable-api-key": publishableKey, Authorization: \`Bearer \${scope.customerToken}\` }`;
    case "admin-token":
      return `{ Authorization: \`Bearer \${scope.adminToken}\` }`;
    case "none":
      return `{ "x-publishable-api-key": publishableKey }`;
  }
}

function urlExpr(plan: StepPlan): string {
  let template = plan.path.template;
  // Substitute left-to-right by occurrence: params are ordered, and `replace`
  // rewrites the first remaining `{param}` each pass, so a repeated name (e.g.
  // both `{id}` in `/store/carts/{id}/line-items/{id}`) binds cart then line item.
  for (const { param, varName } of plan.path.params) {
    template = template.replace(`{${param}}`, `\${scope.${varName}}`);
  }
  const query = Object.entries(plan.query);
  if (query.length === 0) return `\`${template}\``;
  const qs = query
    .map(([key, field]) => {
      const value =
        field.kind === "runtime"
          ? `\${scope.${field.ref}}`
          : field.kind === "raw"
            ? `\${${field.expr}}`
            : encodeURIComponent(String(field.value));
      return `${encodeURIComponent(key)}=${value}`;
    })
    .join("&");
  return `\`${template}?${qs}\``;
}

function bodyLiteral(value: string | number | boolean): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function fieldExpr(field: SynthesizedBody[string]): string {
  if (field.kind === "runtime") return `scope.${field.ref}`;
  if (field.kind === "raw") return field.expr;
  return bodyLiteral(field.value);
}

function synthesizedFieldsExpr(fields: SynthesizedBody): string {
  const entries = Object.entries(fields).map(([key, field]) => `      ${JSON.stringify(key)}: ${fieldExpr(field)},`);
  return `{\n${entries.join("\n")}\n    }`;
}

function bodyExpr(body: BodyPlan): string | null {
  if (body.kind === "empty") return null;
  if (body.kind === "observed") return JSON.stringify(body.payload, null, 2);
  if (body.kind === "synthesized") return synthesizedFieldsExpr(body.fields);
  return null; // unresolvable handled separately as test.fixme
}

function resolveUrlExpr(call: ResolveCall): string {
  // A resolve endpoint may be path-templated (e.g. seeding a line item on the
  // just-created cart: `/store/carts/{cartId}/line-items`). Substitute `{param}`
  // from runtime scope, mirroring the main step's urlExpr.
  const path = call.endpoint.replace(/\{([^}]+)\}/g, (_m, p) => `\${scope.${p}}`);
  const hasPathParam = path !== call.endpoint;
  const query = Object.entries(call.query ?? {});
  if (query.length === 0) return hasPathParam ? `\`${path}\`` : JSON.stringify(call.endpoint);
  const qs = query
    .map(([key, field]) => {
      const value =
        field.kind === "runtime"
          ? `\${scope.${field.ref}}`
          : field.kind === "raw"
            ? `\${${field.expr}}`
            : encodeURIComponent(String(field.value));
      return `${encodeURIComponent(key)}=${value}`;
    })
    .join("&");
  return `\`${path}?${qs}\``;
}

function renderResolveCall(call: ResolveCall, index: number): string {
  // A literal binding emits no request: the auth-gated resource can't be created
  // in this (unauthenticated) context, and the step that consumes the id asserts
  // a 4xx the gate produces from the path prefix alone (see resolve.ts ensure()).
  if (call.literal !== undefined) {
    return `  scope.${call.bindTo} = ${JSON.stringify(call.literal)}; // placeholder: ${call.bindTo} is auth-gated; the negative step's status comes from the gate`;
  }
  const headers = authHeaderExpr(call.auth);
  const varDecl = `resolve${index}`;
  const method = call.method.toLowerCase();
  const options = call.body
    ? `{ headers: ${headers}, data: ${synthesizedFieldsExpr(call.body)} }`
    : `{ headers: ${headers} }`;
  const lines = [
    `  const ${varDecl} = await request.${method}(${resolveUrlExpr(call)}, ${options});`,
  ];
  // A best-effort resolve runs for its side effect (e.g. ensuring an order is
  // fulfilled) and may legitimately 4xx if the post-condition already holds, so
  // its status is not asserted.
  if (!call.bestEffort) {
    lines.push(
      `  expect(${varDecl}.status(), "resolve ${call.method} ${call.endpoint} for ${call.bindTo}").toBe(200);`
    );
  }
  // Predicate selection: bind the first list entry that satisfies the predicate,
  // falling back to the first entry so the resolve never throws (a genuinely
  // absent state then surfaces as the downstream step's own status mismatch — the
  // honest "doesn't reproduce" outcome — rather than an extract crash here).
  if (call.select) {
    const listVar = `${varDecl}List`;
    const finder = call.select.fromEnd ? "findLast" : "find";
    const fallback = call.select.fromEnd ? `${listVar}[${listVar}.length - 1]` : `${listVar}[0]`;
    lines.push(
      `  const ${listVar} = (await ${varDecl}.json()).${call.select.collection} ?? [];`,
      `  scope.${call.bindTo} = (${listVar}.${finder}((it: any) => ${call.select.predicate}) ?? ${fallback})?.${call.select.field};`
    );
  } else if (call.extract !== "") {
    // A side-effecting resolve (e.g. seeding a cart line item) has no extract: run
    // the request and assert it succeeded, but bind nothing into scope.
    lines.push(`  scope.${call.bindTo} = extractPath(await ${varDecl}.json(), ${JSON.stringify(call.extract)});`);
  }
  return lines.join("\n");
}

function renderCaptures(captures: Record<string, string>, respVar: string): string {
  const lines: string[] = [];
  for (const [varName, path] of Object.entries(captures)) {
    // Captures are BEST-EFFORT: a response whose shape differs from the expected
    // path (e.g. Medusa v2 line-items returns `{ cart }`, not `{ line_item }`)
    // must not crash a flow that never consumes this id. Wrap in try/catch — a
    // step that genuinely needs an unset id then fails its OWN status assertion
    // cleanly (the honest "doesn't reproduce" outcome), not with an extract throw.
    const expr =
      path === "$raw"
        ? `(await ${respVar}.json()).token`
        : `extractPath(await ${respVar}.json(), ${JSON.stringify(path)})`;
    lines.push(`  try { scope.${varName} = ${expr}; } catch { }`);
  }
  return lines.join("\n");
}

/**
 * Non-fixme steps are wrapped in `test.step("<METHOD endpoint>", ...)` so the
 * Playwright JSON reporter carries per-step results (test-runner's collect.ts
 * keys results persona→flow→step off these step titles). The flow-level
 * `scope`, `publishableKey`, and any captured ids are declared OUTSIDE the
 * steps (in the test body), so they thread across step boundaries unchanged.
 *
 * `test.fixme(...)` must stay at the TEST level (it skips the whole test), so a
 * fixme step is emitted unwrapped instead of inside a test.step().
 */
function renderStep(
  plan: StepPlan,
  index: number,
  golden: boolean,
  invariants: Invariant[]
): { code: string; fixme: boolean } {
  if (plan.body.kind === "unresolvable") {
    const reason = plan.body.reason.replace(/`/g, "'");
    return {
      fixme: true,
      code: [
        `  test.fixme(true, ${JSON.stringify(
          `TODO: ${plan.step.method} ${plan.step.endpoint} body unresolvable — ${reason}`
        )});`,
        `  return;`,
      ].join("\n"),
    };
  }

  const inner: string[] = [];
  plan.resolveCalls.forEach((call, i) => inner.push(indentStepLine(renderResolveCall(call, index * 10 + i))));

  const headers = authHeaderExpr(plan.auth);
  const body = bodyExpr(plan.body);
  const method = plan.step.method.toLowerCase();
  const respVar = `resp${index}`;
  const optionsParts = [`headers: ${headers}`];
  if (body !== null) {
    optionsParts.push(`data: ${body}`);
  }
  const requestArgs = `${urlExpr(plan)}, { ${optionsParts.join(", ")} }`;

  inner.push(`    const ${respVar} = await request.${method}(${requestArgs});`);
  // Capture the live body BEFORE the status assert (which throws on mismatch),
  // so a failing step still carries its response for advisory triage. Capped +
  // enveloped with the step title so test-runner/collect.ts can map body->step.
  // This is read only via reports/playwright/normalized.json — it never enters
  // the deterministic report.json (ADR 0001 gate path unchanged).
  inner.push(
    `    await test.info().attach("response-body", { body: JSON.stringify({ endpoint: ${JSON.stringify(
      `${plan.step.method} ${plan.step.endpoint}`
    )}, status: ${respVar}.status(), body: (await safeText(${respVar})).slice(0, 4000) }), contentType: "application/json" });`
  );
  inner.push(
    `    expect(${respVar}.status(), ${JSON.stringify(`${plan.step.method} ${plan.step.endpoint}`)}).toBe(${plan.step.expected_status});`
  );

  if (golden) {
    inner.push(
      `    await assertGolden(${JSON.stringify(`${plan.step.method} ${plan.step.endpoint}`)}, ${respVar}.status(), await safeJson(${respVar}));`
    );
  }

  // Behavioral invariants ride AFTER the status assert (and golden): a status
  // drift fails first, then each verified invariant adds a body-level behavioral
  // check (e.g. cart actually converted to an order). Read the parsed body ONCE
  // into a const and reuse it across the invariant asserts.
  if (invariants.length > 0) {
    const bodyVar = `${respVar}Body`;
    inner.push(`    const ${bodyVar} = await safeJson(${respVar});`);
    inner.push(renderInvariants(bodyVar, invariants));
  }

  // Only thread captured IDs forward from a step that is EXPECTED to succeed.
  // An edge step whose expected_status is a non-2xx (e.g. a guest cart mutation
  // the gate 401s) never returns the success body, so `extractPath(..., "cart.id")`
  // would read `.id` of undefined and throw at runtime. Skip the capture for such
  // steps; a downstream consumer of the unset id then fails its own status
  // assertion cleanly (the honest "this flow doesn't reproduce" outcome) instead
  // of crashing.
  const stepSucceeds =
    plan.step.expected_status >= 200 && plan.step.expected_status < 300;
  const captureLines = stepSucceeds ? renderCaptures(plan.captures, respVar) : "";
  if (captureLines) inner.push(indentStepLine(captureLines));

  const stepTitle = `${plan.step.method} ${plan.step.endpoint}`;
  const code = [
    `  await test.step(${JSON.stringify(stepTitle)}, async () => {`,
    ...inner,
    `  });`,
  ].join("\n");

  return { code, fixme: false };
}

function indentStepLine(snippet: string): string {
  return snippet
    .split("\n")
    .map((line) => (line.startsWith("  ") ? `  ${line}` : line))
    .join("\n");
}

function renderSetupInvariants(bodyVar: string, invariants: Invariant[]): string[] {
  const rendered = renderInvariants(bodyVar, invariants);
  if (!rendered) return [];
  return rendered.split("\n").map((line) => line.replace(/^    /, "  "));
}

function needsCustomerAuth(plan: FlowPlan): boolean {
  return plan.steps.some((s) => s.auth === "customer-token");
}

function needsAdminFixture(plan: FlowPlan): boolean {
  const needsAdmin = plan.steps.some((s) => s.auth === "admin-token");
  const flowLogsInItself = plan.steps.some((s) => s.step.method === "POST" && s.step.endpoint === "/auth/user/emailpass");
  return needsAdmin && !flowLogsInItself;
}

export interface EmitOptions {
  candidate: Candidate;
  plan: FlowPlan;
  golden: boolean;
  /** Verified behavioral invariants for this flow, grouped by step title. */
  invariantsByStep?: Map<string, Invariant[]>;
}

export function emitSpec({ candidate, plan, golden, invariantsByStep }: EmitOptions): EmitResult {
  const needsCustomer = needsCustomerAuth(plan);
  const needsAdminViaFixture = needsAdminFixture(plan);
  const invariants = invariantsByStep ?? new Map<string, Invariant[]>();
  const hasInvariants = [...invariants.values()].some((list) => list.length > 0);
  const templateImports = templateImportNames([...invariants.values()].flat().filter(isTemplateInvariant));

  const importLines = [
    `import { test, expect } from "@playwright/test";`,
    golden ? `import { assertGolden } from "../../_golden/assert-golden.js";` : null,
    needsAdminViaFixture ? `import { adminToken } from "../../fixtures/auth.js";` : null,
    templateImports.length > 0
      ? `import { ${templateImports.join(", ")} } from "../../_golden/business-invariants.js";`
      : null,
  ].filter((l): l is string => l !== null);

  // Any flow that touches a customer-gated endpoint OR carries its own
  // register/login needs a real customer SESSION token. Establish it ONCE in
  // setup via the full Medusa v2 handshake (register -> create customer ->
  // login), and skip the flow's OWN handshake steps when emitting. Why always,
  // not "only when the flow lacks a register step": a mined fragment frequently
  // DROPS the login (leaving only a register token, which `requireCustomerAuth`
  // 401s) or REPEATS `POST /store/customers` (duplicate identity -> 400). Auth
  // is test setup, not the behavior under test (the checkout is), so the setup
  // owns it and the redundant in-flow handshake steps are not emitted.
  const hasRegisterStep = plan.steps.some(
    (s) => s.step.method === "POST" && s.step.endpoint === "/auth/customer/emailpass/register"
  );
  const hasLoginStep = plan.steps.some(
    (s) => s.step.method === "POST" && s.step.endpoint === "/auth/customer/emailpass"
  );
  const needsCustomer2 = needsCustomer || hasRegisterStep || hasLoginStep;
  const needsCustomerCreds = needsCustomer2;
  const autoRegister = needsCustomer2;
  const setupCustomerLoginInvariants = (invariants.get("POST /auth/customer/emailpass") ?? []).filter(
    (inv) => inv.polarity !== "error"
  );

  const setupLines: string[] = [
    `  const publishableKey = process.env.MEDUSA_PUBLISHABLE_API_KEY!;`,
    `  const scope: Record<string, string> = {};`,
  ];
  if (needsCustomerCreds) {
    setupLines.push(
      `  const email = \`script-gen-\${Date.now()}-\${Math.floor(Math.random() * 1e6)}@example.com\`;`,
      `  const password = "TestPassword123!";`
    );
  }
  if (autoRegister) {
    // Medusa v2 customer auth handshake. The register call returns a token with
    // an EMPTY `actor_id` — it authorizes creating the customer entity but does
    // NOT satisfy `requireCustomerAuth` (the cart/checkout gate), so using it
    // directly 401s every gated step. Create the customer, then log in to mint a
    // session token whose `actor_id` resolves to a real customer — the token the
    // gate accepts. // VERIFY against live backend (Medusa 2.x auth shapes vary)
    setupLines.push(
      `  const registerResp = await request.post("/auth/customer/emailpass/register", {`,
      `    headers: { "x-publishable-api-key": publishableKey },`,
      `    data: { email, password },`,
      `  });`,
      `  expect(registerResp.status(), "customer register").toBe(200);`,
      `  const registrationToken = (await registerResp.json()).token;`,
      `  const createCustomerResp = await request.post("/store/customers", {`,
      `    headers: { "x-publishable-api-key": publishableKey, Authorization: \`Bearer \${registrationToken}\` },`,
      `    data: { email },`,
      `  });`,
      `  expect(createCustomerResp.status(), "create customer").toBe(200);`,
      `  const loginResp = await request.post("/auth/customer/emailpass", {`,
      `    headers: { "x-publishable-api-key": publishableKey },`,
      `    data: { email, password },`,
      `  });`,
      `  expect(loginResp.status(), "customer login").toBe(200);`
    );
    if (setupCustomerLoginInvariants.length > 0) {
      setupLines.push(
        `  const loginRespBody = await safeJson(loginResp);`,
        ...renderSetupInvariants("loginRespBody", setupCustomerLoginInvariants),
        `  scope.customerToken = getPath(loginRespBody, "token") as string;`
      );
    } else {
      setupLines.push(`  scope.customerToken = (await loginResp.json()).token;`);
    }
  }
  if (needsAdminViaFixture) {
    setupLines.push(`  scope.adminToken = await adminToken(request);`);
  }

  // Stop emitting once a step hits test.fixme()+return: every later step is
  // unreachable (CLAUDE.md §5 no dead code), and may itself depend on a
  // capture the fixme'd step would have produced.
  // The handshake steps the setup now owns (see autoRegister above) — skip
  // emitting them as flow steps so they neither duplicate the setup nor leave a
  // register-only token behind.
  const HANDSHAKE_STEPS = new Set([
    "POST /auth/customer/emailpass/register",
    "POST /store/customers",
    "POST /auth/customer/emailpass",
  ]);

  let fixmeCount = 0;
  const stepBlocks: string[] = [];
  for (let index = 0; index < plan.steps.length; index++) {
    const step = plan.steps[index];
    const stepTitle = `${step.step.method} ${step.step.endpoint}`;
    const failedCustomerLogin = stepTitle === "POST /auth/customer/emailpass" && step.step.expected_status >= 400;
    if (autoRegister && HANDSHAKE_STEPS.has(stepTitle) && !failedCustomerLogin) {
      continue; // owned by setup
    }
    const stepInvariants = invariants.get(stepTitle) ?? [];
    const { code, fixme } = renderStep(step, index, golden, stepInvariants);
    stepBlocks.push(code);
    if (fixme) {
      fixmeCount++;
      break;
    }
  }

  const errorBlock =
    plan.errors.length > 0
      ? [
          `  test.fixme(true, ${JSON.stringify(
            `TODO: unresolved step input(s): ${plan.errors.join("; ")}`
          )});`,
          `  return;`,
        ].join("\n")
      : null;
  if (errorBlock) fixmeCount++;

  const body = [...setupLines, "", ...(errorBlock ? [errorBlock] : stepBlocks)].join("\n");

  const testTitle = `${candidate.persona} — ${candidate.flow_name}`;

  // Provenance travels WITH the test: each spec stamps flow_signature + persona
  // + flow_name + source_sessions as Playwright annotations, so collect.ts lifts
  // them straight out of the JSON reporter rather than reconstructing them from
  // the candidates file. The source_sessions array is JSON-stringified into the
  // annotation `description` (an annotation description is a single string).
  // session_id provenance is a debugging/reporting tag only — never a
  // behavior-engine classifier signal
  // (CLAUDE.md §8.2).
  // The "outcome" half of the flow — its ordered expected-status sequence. Stamped
  // alongside flow_signature (which excludes status, ADR 0002) so the generator can
  // tell an approved oracle from a DRIFTED one with the same signature: preservation
  // keeps a spec only while its stamped outcome is still the blessed one, and retires
  // it once a different outcome is approved for the journey.
  const statusSignature = candidate.steps.map((s) => s.expected_status).join(",");

  const annotationLines = [
    `  test.info().annotations.push({ type: "flow_signature", description: ${JSON.stringify(candidate.signature)} });`,
    `  test.info().annotations.push({ type: "status_signature", description: ${JSON.stringify(statusSignature)} });`,
    `  test.info().annotations.push({ type: "persona", description: ${JSON.stringify(candidate.persona)} });`,
    `  test.info().annotations.push({ type: "flow_name", description: ${JSON.stringify(candidate.flow_name)} });`,
    `  test.info().annotations.push({ type: "source_sessions", description: ${JSON.stringify(
      JSON.stringify(candidate.source_sessions)
    )} });`,
  ].join("\n");

  const source = [
    `// flow_name: ${candidate.flow_name}`,
    `// flow_signature: ${candidate.signature}`,
    `// status_signature: ${statusSignature}`,
    `// persona: ${candidate.persona} | priority: ${candidate.priority} | support: ${candidate.support}`,
    `// Generated by services/script-generator — do not hand-edit; re-running the generator overwrites this file deterministically.`,
    ...importLines,
    `import { extractPath, ${hasInvariants ? "getPath, " : ""}safeJson, safeText } from "../../_golden/util.js";`,
    "",
    `test(${JSON.stringify(testTitle)}, async ({ request }) => {`,
    annotationLines,
    body,
    `});`,
    "",
  ].join("\n");

  return { source, fixmeCount };
}
