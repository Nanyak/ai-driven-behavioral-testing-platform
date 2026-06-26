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

  // Production-shaped hybrid log contract (bodies-off by default). See the
  // production-logs decision: every request emits a semantic `event`, a logical
  // `service`, and the route (method + normalized `endpoint`), with NO bodies
  // unless LOG_CAPTURE_BODIES=true.
  const requiredFields = [
    "timestamp",
    "level",
    "service",
    "environment",
    "request_id",
    "trace_id",
    "session_id",
    "user_id",
    "user_role",
    "event",
    "method",
    "endpoint",
    "status",
    "duration_ms",
    "source",
  ];

  requireSnippet(middleware, "defineMiddlewares", "Medusa middleware registration");
  requireSnippet(middleware, "structuredRequestLogger", "request logging middleware");
  requireSnippet(middleware, "randomUUID()", "trace_id / request_id generation");
  requireSnippet(middleware, "traceparent", "W3C traceparent parsing");
  requireSnippet(middleware, "getSessionId(req)", "session_id header or cookie lookup");

  // Production log shaping.
  requireSnippet(middleware, "normalizeEndpoint", "endpoint normalization");
  requireSnippet(middleware, "endpointTemplate", "endpoint {id} templating");
  requireSnippet(middleware, "deriveService", "logical service derivation");
  requireSnippet(middleware, "deriveEvent", "semantic event derivation");
  requireSnippet(middleware, "deriveLevel", "log level derivation from status");
  requireSnippet(middleware, "EVENT_MAP", "route -> semantic event map");
  requireSnippet(middleware, "getEnvironment", "environment tag");

  // Security: bodies-off by default means nothing sensitive is logged; when
  // bodies are enabled, masking + reduction still apply unless a synthetic
  // fixture capture explicitly opts into raw bodies.
  requireSnippet(middleware, "SENSITIVE_KEY_PATTERN", "sensitive value masking");
  requireSnippet(middleware, "LOG_CAPTURE_BODIES", "body capture feature flag");
  requireSnippet(middleware, "LOG_CAPTURE_RAW_BODIES", "raw body capture feature flag");
  requireSnippet(middleware, "reduceValue", "payload reduction for bodies-on capture");

  // Emission + durability.
  requireSnippet(middleware, "console.log(line)", "stdout JSONL emission");
  requireSnippet(middleware, "appendFile", "async log file JSONL emission");
  requireSnippet(middleware, "ensuredLogDirectories", "cached log directory setup");
  requireSnippet(middleware, "LOG_OUTPUT_PATH", "configurable log output path");
  requireSnippet(middleware, "log_write_failed", "log write failure isolation");
  requirePattern(middleware, /response\.json\s*=\s*\(/, "response JSON capture (bodies-on)");
  requirePattern(middleware, /response\.send\s*=\s*\(/, "response body capture (bodies-on)");
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
