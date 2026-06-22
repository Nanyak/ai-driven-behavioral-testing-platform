#!/usr/bin/env -S npx tsx
/**
 * build-oas.ts — ADR 0004 deterministic overlay.
 *
 * Augments the read-only base Store + Admin OpenAPI spec (`openapi/base/`)
 * with the shared gate's `401` (`GateUnauthorized`) on every operation whose
 * `(path, method)` matches a gate rule from `gate-contract.ts` — the SAME
 * module `middlewares.ts` imports to enforce the gate.
 *
 * Collision rule (ADR 0004 decision #4): if the base already documents the
 * same status for that operation (e.g. a different-trigger 401), the gate
 * response is UNIONED (`oneOf(base, gate)`) — never overwritten — and both
 * trigger conditions are recorded in the response description.
 *
 * Deterministic: no LLM, no timestamps in the output, sorted keys, so
 * building twice from identical inputs is byte-identical.
 *
 * Run: `npm run build-oas` (from services/golden) or `npm run golden:build-oas` (repo root).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GATE_MATCHERS,
  GATE_METHODS,
  GATE_UNAUTHORIZED_STATUS,
} from "../../../apps/medusa/apps/backend/src/api/gate-contract.js";
import { unionSchema } from "../src/schema-merge.js";
import { stableStringify } from "../src/oas-source.js";
import { isRefResponse } from "../src/oas-types.js";
import type { OasDocument, OasInlineResponse, OasMethod, OasResponse, OasSchema } from "../src/oas-types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_DIR = resolvePath(__dirname, "base");
const AUGMENTED_DIR = resolvePath(__dirname, "augmented");

const GATE_UNAUTHORIZED_SCHEMA: OasSchema = { $ref: "#/components/schemas/GateUnauthorized" };
const GATE_UNAUTHORIZED_SCHEMA_DEF = {
  type: "object" as const,
  properties: {
    type: { type: "string" },
    message: { type: "string" },
  },
  required: ["type", "message"],
};

function matchesGate(path: string, method: OasMethod): boolean {
  if (!(GATE_METHODS as readonly string[]).includes(method.toUpperCase())) {
    return false;
  }
  return GATE_MATCHERS.some((matcher) => {
    const prefix = matcher.replace(/\*$/, "");
    return path.startsWith(prefix);
  });
}

const GATE_TRIGGER_DESCRIPTION =
  "Unauthenticated/non-customer request blocked by the requireCustomerAuth gate middleware (ADR 0004).";

/**
 * The real bundled Medusa spec shares common error envelopes via
 * response-level `$ref` (e.g. `responses.401: { $ref: "#/components/responses/unauthorized" }`)
 * rather than inlining them per-operation.
 */
function resolveResponseRef(doc: OasDocument, response: OasResponse): OasInlineResponse {
  if (!isRefResponse(response)) return response;
  const match = /^#\/components\/responses\/(.+)$/.exec(response.$ref);
  if (!match) throw new Error(`Unsupported response $ref: ${response.$ref}`);
  const resolved = doc.components.responses?.[match[1]];
  if (!resolved) throw new Error(`Response $ref does not resolve: ${response.$ref}`);
  return resolved;
}

function injectGateResponse(doc: OasDocument, responses: Record<string, OasResponse>): "added" | "unioned" {
  const statusKey = String(GATE_UNAUTHORIZED_STATUS);
  const existing = responses[statusKey];

  if (!existing) {
    responses[statusKey] = {
      description: GATE_TRIGGER_DESCRIPTION,
      content: {
        "application/json": { schema: GATE_UNAUTHORIZED_SCHEMA },
      },
    };
    return "added";
  }

  // Status already documented for a different trigger (real Medusa spec: a
  // response-level $ref to `components/responses/unauthorized`, a `text/plain`
  // envelope distinct from the gate's `application/json` GateUnauthorized
  // envelope) — union the schemas, NEVER overwrite (ADR 0004 #4).
  const resolvedExisting = resolveResponseRef(doc, existing);
  const existingMediaType = resolvedExisting.content?.["application/json"] ?? firstMediaType(resolvedExisting.content);
  const existingSchema = existingMediaType?.schema;
  const unionedSchema: OasSchema = existingSchema
    ? { oneOf: [existingSchema, GATE_UNAUTHORIZED_SCHEMA] }
    : GATE_UNAUTHORIZED_SCHEMA;

  responses[statusKey] = {
    description: `${resolvedExisting.description} ALSO: ${GATE_TRIGGER_DESCRIPTION}`,
    content: {
      "application/json": { schema: unionedSchema },
    },
  };
  return "unioned";
}

function firstMediaType(
  content: Record<string, { schema: OasSchema }> | undefined
): { schema: OasSchema } | undefined {
  if (!content) return undefined;
  const key = Object.keys(content)[0];
  return key ? content[key] : undefined;
}

export interface OverlayReport {
  gateInjections: { path: string; method: string; status: "added" | "unioned" }[];
}

// Exported (not just used by main()) so tests can exercise both the pure-add
// AND union collision branches against a small synthetic document — the real
// committed `base/store.json` only exercises the union branch (every real
// gated operation already documents a 401), so the add branch needs a
// controlled fixture to stay covered (see `test/build-oas.test.ts`).
export function applyGateOverlay(doc: OasDocument, report: OverlayReport): void {
  doc.components.schemas.GateUnauthorized ??= GATE_UNAUTHORIZED_SCHEMA_DEF;

  for (const [path, pathItem] of Object.entries(doc.paths)) {
    for (const [method, operation] of Object.entries(pathItem) as [OasMethod, typeof pathItem[OasMethod]][]) {
      if (!operation || !matchesGate(path, method)) continue;
      const status = injectGateResponse(doc, operation.responses);
      report.gateInjections.push({ path, method: method.toUpperCase(), status });
    }
  }
}

function loadBase(name: "store" | "admin"): OasDocument {
  return JSON.parse(readFileSync(resolvePath(BASE_DIR, `${name}.json`), "utf8")) as OasDocument;
}

export function buildAugmentedSpec(name: "store" | "admin"): { doc: OasDocument; report: OverlayReport } {
  const doc = loadBase(name);
  const report: OverlayReport = { gateInjections: [] };
  applyGateOverlay(doc, report);
  return { doc, report };
}

/** Advisory drift report: same-status, differing-schema entries between base and overlay. Human-only. */
function buildDriftReport(base: OasDocument, augmented: OasDocument): string[] {
  const lines: string[] = [];
  for (const [path, pathItem] of Object.entries(augmented.paths)) {
    for (const [method, operation] of Object.entries(pathItem) as [OasMethod, typeof pathItem[OasMethod]][]) {
      const baseOperation = base.paths[path]?.[method];
      if (!operation || !baseOperation) continue;
      for (const [status, response] of Object.entries(operation.responses)) {
        const baseResponse = baseOperation.responses[status];
        if (!baseResponse) continue;
        const resolvedBase = resolveResponseRef(base, baseResponse);
        const resolvedAug = resolveResponseRef(augmented, response);
        const baseSchema = resolvedBase.content?.["application/json"]?.schema;
        const augSchema = resolvedAug.content?.["application/json"]?.schema;
        if (baseSchema && augSchema && stableStringify(baseSchema) !== stableStringify(augSchema)) {
          const { conflicts } = unionSchema(
            // Best-effort structural compare for the advisory note only.
            JSON.parse(stableStringify(baseSchema)),
            JSON.parse(stableStringify(augSchema))
          );
          lines.push(
            `${method.toUpperCase()} ${path} [${status}]: base/overlay schema differs` +
              (conflicts.length ? ` (${conflicts.length} field conflict(s))` : "")
          );
        }
      }
    }
  }
  return lines;
}

function main(): void {
  mkdirSync(AUGMENTED_DIR, { recursive: true });

  const storeBase = loadBase("store");
  const adminBase = loadBase("admin");

  const { doc: store, report: storeReport } = buildAugmentedSpec("store");
  const { doc: admin, report: adminReport } = buildAugmentedSpec("admin");

  // No timestamps in the output; sorted keys for byte-identical rebuilds.
  writeFileSync(resolvePath(AUGMENTED_DIR, "store.json"), `${stableStringify(store)}\n`, "utf8");
  writeFileSync(resolvePath(AUGMENTED_DIR, "admin.json"), `${stableStringify(admin)}\n`, "utf8");

  const drift = [...buildDriftReport(storeBase, store), ...buildDriftReport(adminBase, admin)];

  console.log(`build-oas: wrote ${AUGMENTED_DIR}`);
  console.log(`  store: ${storeReport.gateInjections.length} gate injection(s)`);
  console.log(`  admin: ${adminReport.gateInjections.length} gate injection(s)`);
  for (const injection of [...storeReport.gateInjections, ...adminReport.gateInjections]) {
    console.log(`    ${injection.status} ${injection.method} ${injection.path}`);
  }
  if (drift.length) {
    console.log(`\nAdvisory drift report (human-only, never fed back):`);
    for (const line of drift) console.log(`  - ${line}`);
  }
}

const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main();
}
