/**
 * Output is LABEL-FREE by design: no persona is assigned here. The behavior
 * engine derives persona as an emergent attribute, so ingestion must never
 * pre-label sessions or the discovery claim collapses.
 */

import type {
  FlowStep,
  GoldenCandidate,
  ObservedRole,
  RawLogDoc,
  SchemaNode,
  SessionFlow,
} from "./types.js";

// NORMALIZATION IS LOAD-BEARING (ADR 0002): the canonical flow signature is a
// hash of `METHOD <normalized endpoint>` tokens, so these rules must stay
// stable. A cosmetic change here re-keys every signature and makes previously
// covered flows look new. Change with care.

const PLACEHOLDER = "{id}";

const DYNAMIC_SEGMENT_PATTERNS: RegExp[] = [
  /^\d+$/,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  /^[0-9a-f]{24,}$/i,
  // Medusa prefixed id, e.g. cart_01H..., prod_..., li_... — underscores never
  // appear in real route segments (Medusa uses hyphens: line-items,
  // payment-collections), so a `<word>_<rest>` segment is always an id. This
  // also catches synthetic edge-case ids like `prod_does_not_exist`.
  /^[a-zA-Z]+_[a-zA-Z0-9_]+$/,
];

const PLACEHOLDER_SEGMENT = /^(\{[^}]+\}|:[A-Za-z_]+)$/;

function normalizeSegment(segment: string): string {
  if (!segment) {
    return segment;
  }
  if (PLACEHOLDER_SEGMENT.test(segment)) {
    return PLACEHOLDER;
  }
  for (const pattern of DYNAMIC_SEGMENT_PATTERNS) {
    if (pattern.test(segment)) {
      return PLACEHOLDER;
    }
  }
  return segment;
}

export function normalizeEndpoint(rawEndpoint: string): string {
  const pathname = (rawEndpoint.split("?")[0] || "/").replace(/\/+$/, "") || "/";
  return pathname.split("/").map(normalizeSegment).join("/");
}

// Matching is on the *normalized* endpoint.
const DENY_EXACT = new Set<string>(["/", "/health", "/favicon.ico", "/robots.txt"]);
const DENY_PREFIXES: string[] = ["/health", "/app", "/_next", "/assets", "/static"];
const STATIC_ASSET_EXT = /\.(?:js|mjs|css|map|png|jpe?g|gif|svg|ico|woff2?|ttf|webp)$/i;

// A path segment left by a FAILED client-side id interpolation — the storefront
// built a URL like `/store/carts/${cart.id}` while `cart.id` was undefined (cart
// creation had 401'd), emitting the JS string coercion as a literal segment.
// `POST /store/carts/undefined` is not a Medusa route; it is a malformed request
// that carries no behavioral meaning. We DROP it as noise rather than normalize it
// to `{id}` — normalizing would fabricate a plausible-looking dynamic-id route out
// of a client bug and let the broken capture mine as a real flow.
const BROKEN_INTERPOLATION_SEGMENTS = new Set(["undefined", "null", "NaN", "[object Object]"]);

function hasBrokenInterpolationSegment(normalizedEndpoint: string): boolean {
  return normalizedEndpoint
    .split("/")
    .some((segment) => BROKEN_INTERPOLATION_SEGMENTS.has(segment));
}

export function isNoiseEndpoint(endpoint: string): boolean {
  const normalized = normalizeEndpoint(endpoint);

  if (DENY_EXACT.has(normalized)) {
    return true;
  }
  if (hasBrokenInterpolationSegment(normalized)) {
    return true;
  }
  if (STATIC_ASSET_EXT.test(normalized)) {
    return true;
  }
  for (const prefix of DENY_PREFIXES) {
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  return false;
}

export interface SessionBucket {
  sessionId: string;
  docs: RawLogDoc[];
}

export interface GroupResult {
  buckets: SessionBucket[];
  droppedNoSession: number;
}

export function groupBySession(docs: RawLogDoc[]): GroupResult {
  const bySession = new Map<string, RawLogDoc[]>();
  let droppedNoSession = 0;

  for (const doc of docs) {
    const sessionId = doc.session_id;
    if (!sessionId) {
      droppedNoSession++;
      continue;
    }
    const bucket = bySession.get(sessionId);
    if (bucket) {
      bucket.push(doc);
    } else {
      bySession.set(sessionId, [doc]);
    }
  }

  const buckets: SessionBucket[] = [];
  for (const [sessionId, sessionDocs] of bySession) {
    sessionDocs.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    buckets.push({ sessionId, docs: sessionDocs });
  }

  return { buckets, droppedNoSession };
}

// `role_observed` is VALIDATION GROUND TRUTH ONLY (never a classifier input).
// No persona field is ever written here.
const ROLE_RANK: Record<ObservedRole, number> = { guest: 0, customer: 1, admin: 2 };

function toObservedRole(userRole: string | null | undefined): ObservedRole {
  switch (userRole) {
    case "customer":
      return "customer";
    case "user":
    case "admin":
      return "admin";
    default:
      return "guest";
  }
}

function toStep(doc: RawLogDoc): FlowStep {
  const status = doc.status ?? 0;
  return {
    method: (doc.method ?? "GET").toUpperCase(),
    endpoint: normalizeEndpoint(doc.endpoint ?? "/"),
    event: doc.event ?? null,
    status,
    trace_id: doc.trace_id ?? null,
    timestamp: doc.timestamp,
    request_payload: doc.request_payload ?? null,
    has_error: status >= 400,
  };
}

export interface BuildResult {
  sessions: SessionFlow[];
  droppedSingleStep: number;
}

/**
 * Turn session buckets into flow records. A session is kept when it has ≥2
 * behavioral steps, OR it is an error-only edge case worth keeping (a single
 * 4xx/5xx step still carries signal — e.g. an unauthenticated admin probe).
 */
export function buildSessionFlows(buckets: SessionBucket[]): BuildResult {
  const sessions: SessionFlow[] = [];
  let droppedSingleStep = 0;

  for (const bucket of buckets) {
    const steps: FlowStep[] = [];
    const roles = new Set<ObservedRole>();

    for (const doc of bucket.docs) {
      if (isNoiseEndpoint(doc.endpoint ?? "/")) {
        continue;
      }
      steps.push(toStep(doc));
      roles.add(toObservedRole(doc.user_role));
    }

    if (steps.length === 0) {
      continue;
    }
    if (steps.length === 1 && !steps[0].has_error) {
      droppedSingleStep++;
      continue;
    }

    const roleObserved = [...roles].sort((a, b) => ROLE_RANK[a] - ROLE_RANK[b]);

    sessions.push({
      session_id: bucket.sessionId,
      started_at: steps[0].timestamp,
      ended_at: steps[steps.length - 1].timestamp,
      role_observed: roleObserved,
      steps,
    });
  }

  return { sessions, droppedSingleStep };
}

// OBSERVED HALF of the ADR 0001 intersection — snapshots schemas only, never
// compares (comparison is golden/test-runner). With bodies-off logs there are no
// response bodies, so this contributes nothing and the golden service falls back
// to spec-only goldens — expected, not an error (ADR 0001).
const IGNORE_FIELDS = [
  "id",
  "created_at",
  "updated_at",
  "deleted_at",
  "metadata",
  "token",
  "cart_id",
  "order_id",
  "trace_id",
  "session_id",
];
const IGNORE_SET = new Set(IGNORE_FIELDS);

function describe(value: unknown): SchemaNode {
  if (value === null || value === undefined) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object": {
      const node: { [key: string]: SchemaNode } = {};
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        node[key] = IGNORE_SET.has(key) ? "ignored" : describe(child);
      }
      return node;
    }
    default:
      return "object";
  }
}

function isObjectNode(node: SchemaNode): node is { [key: string]: SchemaNode } {
  return typeof node === "object";
}

function mergeSchema(a: SchemaNode, b: SchemaNode): SchemaNode {
  if (isObjectNode(a) && isObjectNode(b)) {
    const merged: { [key: string]: SchemaNode } = { ...a };
    for (const [key, node] of Object.entries(b)) {
      merged[key] = key in merged ? mergeSchema(merged[key], node) : node;
    }
    return merged;
  }
  // Leaf vs leaf (or shape mismatch): keep the first non-null observation.
  return a === "null" ? b : a;
}

interface Accumulator {
  endpoint: string;
  status: number;
  schema: SchemaNode;
  sessions: Set<string>;
}

export function extractGoldenCandidates(
  docs: RawLogDoc[],
  capturedAt: string
): GoldenCandidate[] {
  const byKey = new Map<string, Accumulator>();

  for (const doc of docs) {
    if (doc.response_body === undefined || doc.response_body === null) {
      continue;
    }
    const endpoint = doc.endpoint ?? "/";
    if (isNoiseEndpoint(endpoint)) {
      continue;
    }
    const method = (doc.method ?? "GET").toUpperCase();
    const status = doc.status ?? 0;
    const route = `${method} ${normalizeEndpoint(endpoint)}`;
    const key = `${route}::${status}`;
    const schema = describe(doc.response_body);

    const existing = byKey.get(key);
    if (existing) {
      existing.schema = mergeSchema(existing.schema, schema);
      if (doc.session_id) {
        existing.sessions.add(doc.session_id);
      }
    } else {
      byKey.set(key, {
        endpoint: route,
        status,
        schema,
        sessions: new Set(doc.session_id ? [doc.session_id] : []),
      });
    }
  }

  return [...byKey.values()]
    .map<GoldenCandidate>((acc) => ({
      endpoint: acc.endpoint,
      expected_status: acc.status,
      expected_schema: acc.schema,
      ignore_fields: IGNORE_FIELDS,
      schema_source: "observed",
      captured_at: capturedAt,
      source_sessions: [...acc.sessions].sort(),
    }))
    .sort((a, b) =>
      a.endpoint === b.endpoint
        ? a.expected_status - b.expected_status
        : a.endpoint.localeCompare(b.endpoint)
    );
}

export function goldenFileName(candidate: GoldenCandidate): string {
  const slug = `${candidate.endpoint}-${candidate.expected_status}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug}.json`;
}
