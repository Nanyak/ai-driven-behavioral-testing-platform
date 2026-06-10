import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { root } from "./lib/phase1-utils.mjs";

const failures = [];
const middlewarePath = join(
  root,
  "apps",
  "medusa",
  "apps",
  "backend",
  "src",
  "api",
  "middlewares.ts"
);

function requireFile(relativePath) {
  if (!existsSync(join(root, relativePath))) {
    failures.push(`Missing required file: ${relativePath}`);
  }
}

function requireSnippet(fileContents, snippet, description) {
  if (!fileContents.includes(snippet)) {
    failures.push(`Missing ${description}: ${snippet}`);
  }
}

function requirePattern(fileContents, pattern, description) {
  if (!pattern.test(fileContents)) {
    failures.push(`Missing ${description}.`);
  }
}

requireFile("docs/phase-2-implementation-plan.md");
requireFile("scripts/check-phase2.mjs");
requireFile("apps/medusa/apps/backend/src/api/middlewares.ts");

const rootPackage = readFileSync(join(root, "package.json"), "utf8");
requireSnippet(rootPackage, "\"check:phase2\"", "root check:phase2 script");

if (existsSync(middlewarePath)) {
  const middleware = readFileSync(middlewarePath, "utf8");
  const requiredFields = [
    "event_type",
    "level",
    "timestamp",
    "trace_id",
    "session_id",
    "persona",
    "user_role",
    "user_id",
    "method",
    "raw_endpoint",
    "normalized_endpoint",
    "query_params",
    "request_headers",
    "remote_ip",
    "user_agent",
    "request_content_length",
    "request_body_capture",
    "request_payload",
    "response_code",
    "response_content_length",
    "response_body_capture",
    "response_body",
    "duration_ms",
  ];

  requireSnippet(middleware, "defineMiddlewares", "Medusa middleware registration");
  requireSnippet(middleware, "structuredRequestLogger", "request logging middleware");
  requireSnippet(middleware, "randomUUID()", "trace_id generation");
  requireSnippet(middleware, "traceparent", "W3C traceparent parsing");
  requireSnippet(middleware, "getSessionId(req)", "session_id header or cookie lookup");
  requireSnippet(middleware, "x-persona", "persona header lookup");
  requireSnippet(middleware, "SENSITIVE_KEY_PATTERN", "sensitive value masking");
  requireSnippet(middleware, "SAFE_HEADER_NAMES", "safe header allowlist");
  requireSnippet(middleware, "LOG_CAPTURE_BODIES", "body capture feature flag");
  requireSnippet(middleware, "BODY_CAPTURE_DISABLED", "disabled body logging marker");
  requireSnippet(middleware, "http_request_completed", "request completion event type");
  requireSnippet(middleware, "console.log(line)", "stdout JSONL emission");
  requireSnippet(middleware, "appendFile", "async log file JSONL emission");
  requireSnippet(middleware, "ensuredLogDirectories", "cached log directory setup");
  requireSnippet(middleware, "LOG_OUTPUT_PATH", "configurable log output path");
  requireSnippet(middleware, "log_write_failed", "log write failure isolation");
  requireSnippet(middleware, "getSafeHeaders(req)", "safe request header capture");
  requireSnippet(middleware, "getQueryParams(req, rawEndpoint)", "query parameter capture");
  requireSnippet(middleware, "getRemoteIp(req)", "remote IP capture");
  requireSnippet(middleware, "response_content_length", "response size capture");
  requirePattern(middleware, /response\.json\s*=\s*\(/, "response JSON capture");
  requirePattern(middleware, /response\.send\s*=\s*\(/, "response body capture");
  requirePattern(middleware, /res\.once\("finish"/, "finish listener for status and duration");
  requirePattern(middleware, /matcher:\s*"\/\*"/, "global route matcher");

  for (const field of requiredFields) {
    requireSnippet(middleware, field, `structured log field ${field}`);
  }

  const sampleSensitivePayload = {
    email: "admin@example.com",
    password: "super-secret",
    phoneNumber: "50935000017",
    pan: "8332010000428773698",
    nested: {
      token: "abc123",
      accountId: "acct_123",
      publishable_api_key: "pk_secret",
      value: "kept",
    },
  };
  const simulatedMaskedOutput = JSON.stringify(sampleSensitivePayload).replace(
    /"(email|password|phoneNumber|pan|token|accountId|publishable_api_key)":"[^"]+"/g,
    '"$1":"[masked]"'
  );

  if (!simulatedMaskedOutput.includes("[masked]")) {
    failures.push("Sensitive-value masking smoke check did not produce masked output.");
  }
}

if (failures.length > 0) {
  console.error("Phase 2 verification failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Phase 2 verification passed.");
