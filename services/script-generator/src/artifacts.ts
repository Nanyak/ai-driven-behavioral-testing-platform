import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { BodyPlan, FlowPlan, SynthesizedBody } from "./resolve.js";

export type BodyRuleSource = "openapi" | "observed" | "profile";

export interface BodyPlanReviewStep {
  index: number;
  method: string;
  endpoint: string;
  expected_status: number;
  source: BodyRuleSource;
  auth: string;
  query: SynthesizedBody;
  body: BodyPlan;
  prerequisite_calls: Array<{
    method: string;
    endpoint: string;
    bind_to: string;
    has_body: boolean;
    has_query: boolean;
  }>;
  request_body_evidence: unknown | null;
  selected_optional_fields: string[];
}

export interface BodyPlanReview {
  version: 1;
  steps: BodyPlanReviewStep[];
  generation_errors: string[];
}

export interface GenerationManifestEntry {
  review_id: string;
  flow_signature: string;
  status_signature: string;
  test_path: string;
  generated_spec_hash: string;
  body_plan_hash: string;
  body_rule_sources: BodyRuleSource[];
  body_plan: BodyPlanReview;
}

export interface GenerationManifest {
  version: 1;
  generated_at: string;
  entries: GenerationManifestEntry[];
}

const SENSITIVE_FIELD =
  /password|passwd|pwd|token|secret|authorization|cookie|api[-_]?key|session|csrf|jwt|credential|phone|email|address|pan|card|payment|account|paper|document|ssn|tin|first_name|last_name|^name$/i;

function redactObserved(value: unknown, key = "", maskLeaves = false): unknown {
  const sensitive = maskLeaves || SENSITIVE_FIELD.test(key);
  if (Array.isArray(value)) return value.map((item) => redactObserved(item, "", sensitive));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
        childKey,
        redactObserved(child, childKey, sensitive),
      ])
    );
  }
  if (sensitive) return "<redacted>";
  return value;
}

function reviewBody(body: BodyPlan): BodyPlan {
  return body.kind === "observed"
    ? { kind: "observed", payload: redactObserved(body.payload) }
    : body;
}

const PROFILE_ENDPOINTS = new Set([
  "POST /auth/user/emailpass",
  "POST /auth/customer/emailpass",
  "POST /auth/customer/emailpass/register",
  "POST /store/customers",
  "POST /admin/returns",
  "POST /admin/returns/{id}/request-items",
  "POST /admin/returns/{id}/receive-items",
  "POST /admin/products",
]);

function bodyRuleSource(method: string, endpoint: string, expectedStatus: number, body: BodyPlan): BodyRuleSource {
  if (body.source) return body.source;
  if (body.kind === "observed") return "observed";
  const key = `${method} ${endpoint}`;
  if (
    PROFILE_ENDPOINTS.has(key) ||
    (method === "POST" && endpoint.endsWith("/fulfillments")) ||
    (expectedStatus >= 400 &&
      (key === "POST /store/carts/{id}" || key === "POST /store/carts/{id}/line-items"))
  ) {
    return "profile";
  }
  return "openapi";
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function bodyPlanReview(plan: FlowPlan): BodyPlanReview {
  return {
    version: 1,
    steps: plan.steps.map((step, index) => ({
      index,
      method: step.step.method,
      endpoint: step.step.endpoint,
      expected_status: step.step.expected_status,
      source: bodyRuleSource(step.step.method, step.step.endpoint, step.step.expected_status, step.body),
      auth: step.auth,
      query: step.query,
      body: reviewBody(step.body),
      prerequisite_calls: step.resolveCalls.map((call) => ({
        method: call.method,
        endpoint: call.endpoint,
        bind_to: call.bindTo,
        has_body: Boolean(call.body),
        has_query: Boolean(call.query),
      })),
      request_body_evidence: step.step.request_body_evidence ?? null,
      selected_optional_fields: step.body.observed_optional_fields ?? [],
    })),
    generation_errors: [...plan.errors],
  };
}

export function manifestEntry(
  flowSignature: string,
  testPath: string,
  source: string,
  plan: FlowPlan
): GenerationManifestEntry {
  const review = bodyPlanReview(plan);
  const sources = [...new Set(review.steps.map((step) => step.source))];
  const statusSignature = plan.steps.map((step) => step.step.expected_status).join(",");
  return {
    review_id: `${flowSignature.toLowerCase()}:${statusSignature || "unknown"}`,
    flow_signature: flowSignature.toLowerCase(),
    status_signature: statusSignature,
    test_path: testPath,
    generated_spec_hash: sha256(source),
    body_plan_hash: sha256(JSON.stringify(review)),
    body_rule_sources: sources,
    body_plan: review,
  };
}

function readManifest(path: string): GenerationManifest | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as GenerationManifest;
    return parsed.version === 1 && Array.isArray(parsed.entries) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeGenerationManifest(
  generatedTestsDir: string,
  newEntries: GenerationManifestEntry[]
): void {
  const path = resolvePath(generatedTestsDir, ".artifacts.json");
  const prior = readManifest(path)?.entries ?? [];
  const byReview = new Map<string, GenerationManifestEntry>();

  for (const entry of prior) {
    if (existsSync(resolvePath(generatedTestsDir, entry.test_path))) {
      const source = readFileSync(resolvePath(generatedTestsDir, entry.test_path), "utf8");
      const inferredStatus =
        entry.status_signature ||
        /status_signature["'\s:=]+([\d,]+)/i.exec(source)?.[1] ||
        "";
      const inferredReviewId =
        entry.review_id?.trim() ||
        `${entry.flow_signature}:${inferredStatus || "unknown"}`;
      byReview.set(
        inferredReviewId,
        {
          ...entry,
          review_id: inferredReviewId,
          status_signature: inferredStatus,
        }
      );
    }
  }
  for (const entry of newEntries) {
    byReview.set(entry.review_id, entry);
  }

  const manifest: GenerationManifest = {
    version: 1,
    generated_at: new Date().toISOString(),
    entries: [...byReview.values()].sort((a, b) => a.test_path.localeCompare(b.test_path)),
  };
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
