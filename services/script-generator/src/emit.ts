/**
 * Emit (plan §Implementation steps #3, #5, #6). Renders a candidate's
 * `FlowPlan` into a `.spec.ts` source string: resolve calls, the request,
 * status + golden assertions, threading captured IDs through `scope`.
 *
 * Filenames are derived from the candidate's signature (plan §3 / ADR 0002),
 * not an index, so regeneration is idempotent — handled by the caller
 * (`run.ts`), not here.
 */
import type { Candidate } from "./load.js";
import type { AuthRequirement, BodyPlan, FlowPlan, ResolveCall, StepPlan } from "./resolve.js";

export interface EmitResult {
  source: string;
  /** `test.fixme` bodies emitted, for the run summary. */
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

function pathExpr(plan: StepPlan): string {
  let template = plan.path.template;
  for (const [param, varName] of Object.entries(plan.path.params)) {
    template = template.replace(`{${param}}`, `\${scope.${varName}}`);
  }
  return `\`${template}\``;
}

function bodyLiteral(value: string | number | boolean): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function synthesizedFieldsExpr(fields: Record<string, { kind: "literal"; value: string | number | boolean } | { kind: "runtime"; ref: string }>): string {
  const entries = Object.entries(fields).map(([key, field]) => {
    const value = field.kind === "runtime" ? `scope.${field.ref}` : bodyLiteral(field.value);
    return `      ${JSON.stringify(key)}: ${value},`;
  });
  return `{\n${entries.join("\n")}\n    }`;
}

function bodyExpr(body: BodyPlan): string | null {
  if (body.kind === "empty") return null;
  if (body.kind === "observed") return JSON.stringify(body.payload, null, 2);
  if (body.kind === "synthesized") return synthesizedFieldsExpr(body.fields);
  return null; // unresolvable handled separately as test.fixme
}

function renderResolveCall(call: ResolveCall, index: number): string {
  const headers = authHeaderExpr(call.auth);
  const varDecl = `resolve${index}`;
  const method = call.method.toLowerCase();
  const options = call.body
    ? `{ headers: ${headers}, data: ${synthesizedFieldsExpr(call.body)} }`
    : `{ headers: ${headers} }`;
  return [
    `  const ${varDecl} = await request.${method}(${JSON.stringify(call.endpoint)}, ${options});`,
    `  expect(${varDecl}.status(), "resolve ${call.method} ${call.endpoint} for ${call.bindTo}").toBe(200);`,
    `  scope.${call.bindTo} = extractPath(await ${varDecl}.json(), ${JSON.stringify(call.extract)});`,
  ].join("\n");
}

function renderCaptures(captures: Record<string, string>, respVar: string): string {
  const lines: string[] = [];
  for (const [varName, path] of Object.entries(captures)) {
    if (path === "$raw") {
      lines.push(`  scope.${varName} = (await ${respVar}.json()).token;`);
    } else {
      lines.push(`  scope.${varName} = extractPath(await ${respVar}.json(), ${JSON.stringify(path)});`);
    }
  }
  return lines.join("\n");
}

/** Render one step (resolve calls + request + assertions) or a `test.fixme` block. */
function renderStep(plan: StepPlan, index: number, golden: boolean): { code: string; fixme: boolean } {
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

  const lines: string[] = [];
  plan.resolveCalls.forEach((call, i) => lines.push(renderResolveCall(call, index * 10 + i)));

  const headers = authHeaderExpr(plan.auth);
  const body = bodyExpr(plan.body);
  const method = plan.step.method.toLowerCase();
  const respVar = `resp${index}`;
  const optionsParts = [`headers: ${headers}`];
  if (body !== null) {
    optionsParts.push(`data: ${body}`);
  }
  const requestArgs = `${pathExpr(plan)}, { ${optionsParts.join(", ")} }`;

  lines.push(`  const ${respVar} = await request.${method}(${requestArgs});`);
  lines.push(
    `  expect(${respVar}.status(), ${JSON.stringify(`${plan.step.method} ${plan.step.endpoint}`)}).toBe(${plan.step.expected_status});`
  );

  if (golden) {
    lines.push(
      `  await assertGolden(${JSON.stringify(`${plan.step.method} ${plan.step.endpoint}`)}, ${respVar}.status(), await safeJson(${respVar}));`
    );
  }

  const captureLines = renderCaptures(plan.captures, respVar);
  if (captureLines) lines.push(captureLines);

  return { code: lines.join("\n"), fixme: false };
}

/** Whether a flow plan needs a customer token (so the test must register/login in-test). */
function needsCustomerAuth(plan: FlowPlan): boolean {
  return plan.steps.some((s) => s.auth === "customer-token");
}

/** Whether a flow plan needs an admin token AND has no admin-login step of its own. */
function needsAdminFixture(plan: FlowPlan): boolean {
  const needsAdmin = plan.steps.some((s) => s.auth === "admin-token");
  const flowLogsInItself = plan.steps.some((s) => s.step.method === "POST" && s.step.endpoint === "/auth/user/emailpass");
  return needsAdmin && !flowLogsInItself;
}

export interface EmitOptions {
  candidate: Candidate;
  plan: FlowPlan;
  folder: "guest" | "customer" | "admin" | "edge";
  golden: boolean;
}

/** Render a full `.spec.ts` source for one candidate's flow plan. */
export function emitSpec({ candidate, plan, folder, golden }: EmitOptions): EmitResult {
  const needsCustomer = needsCustomerAuth(plan);
  const needsAdminViaFixture = needsAdminFixture(plan);

  const importLines = [
    `import { test, expect } from "@playwright/test";`,
    golden ? `import { assertGolden } from "../_golden/assert-golden.js";` : null,
    needsAdminViaFixture ? `import { adminToken } from "../fixtures/auth.js";` : null,
  ].filter((l): l is string => l !== null);

  const setupLines: string[] = [
    `  const publishableKey = process.env.MEDUSA_PUBLISHABLE_KEY!;`,
    `  const scope: Record<string, string> = {};`,
  ];
  if (needsCustomer) {
    setupLines.push(
      `  const email = \`script-gen-\${Date.now()}-\${Math.floor(Math.random() * 1e6)}@example.com\`;`,
      `  const password = "TestPassword123!";`,
      `  const registerResp = await request.post("/auth/customer/emailpass/register", {`,
      `    headers: { "x-publishable-api-key": publishableKey },`,
      `    data: { email, password },`,
      `  });`,
      `  expect(registerResp.status(), "customer register").toBe(200);`,
      `  scope.customerToken = (await registerResp.json()).token;`
    );
  }
  if (needsAdminViaFixture) {
    setupLines.push(`  scope.adminToken = await adminToken(request);`);
  }

  // Stop emitting once a step hits test.fixme()+return: every later step is
  // unreachable (CLAUDE.md §5 no dead code), and may itself depend on a
  // capture the fixme'd step would have produced.
  let fixmeCount = 0;
  const stepBlocks: string[] = [];
  for (let index = 0; index < plan.steps.length; index++) {
    const { code, fixme } = renderStep(
      plan.steps[index],
      index,
      golden && (folder === "guest" || folder === "customer" || folder === "admin")
    );
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
  const annotationLine = `  test.info().annotations.push({ type: "flow_signature", description: ${JSON.stringify(candidate.signature)} });`;

  const source = [
    `// flow_signature: ${candidate.signature}`,
    `// persona: ${candidate.persona} | priority: ${candidate.priority} | support: ${candidate.support}`,
    `// Generated by services/script-generator — do not hand-edit; re-running the generator overwrites this file deterministically.`,
    ...importLines,
    `import { extractPath, safeJson } from "../_golden/util.js";`,
    "",
    `test(${JSON.stringify(testTitle)}, async ({ request }) => {`,
    annotationLine,
    body,
    `});`,
    "",
  ].join("\n");

  return { source, fixmeCount };
}
