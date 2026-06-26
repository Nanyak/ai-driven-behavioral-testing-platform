/**
 * Output is LABEL-FREE by design: no persona is assigned here. The behavior
 * engine derives persona as an emergent attribute, so ingestion must never
 * pre-label sessions or the discovery claim collapses.
 */

import { createHash } from "node:crypto";

import type {
  BodyArrayFeature,
  BodyArrayLengthBucket,
  BodyFeatures,
  BodyPrimitivePath,
  BodyPrimitiveType,
  BodyRootKind,
  BodyScalarHint,
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

const MAX_BODY_NODES = 500;
const MAX_BODY_DEPTH = 8;
const MAX_FEATURE_PATHS = 200;
const MAX_ARRAY_ITEMS_TO_SCAN = 20;
const MAX_SAFE_STRING_LENGTH = 48;

const SAFE_STRING_FIELD_NAMES = new Set([
  "action",
  "currency",
  "currency_code",
  "country_code",
  "event",
  "fulfillment_status",
  "kind",
  "language",
  "locale",
  "mode",
  "payment_status",
  "state",
  "status",
  "type",
]);

const SAFE_NUMBER_FIELD_NAMES = new Set([
  "count",
  "limit",
  "offset",
  "page",
  "page_size",
  "quantity",
]);

const MASKED_VALUE_PATTERNS: RegExp[] = [
  /^\*+$/,
  /^x+$/i,
  /^\[?(?:masked|redacted|hidden)\]?$/i,
  /^<\s*(?:masked|redacted|hidden)\s*>$/i,
];

const SENSITIVE_FIELD_PATTERNS: RegExp[] = [
  /password/i,
  /passcode/i,
  /secret/i,
  /token/i,
  /authorization/i,
  /^auth$/i,
  /cookie/i,
  /session/i,
  /jwt/i,
  /email/i,
  /phone/i,
  /address/i,
  /^name$/i,
  /first_name/i,
  /last_name/i,
  /ip_address/i,
  /ssn/i,
  /card/i,
  /cvv/i,
];

const UNSAFE_SCALAR_FIELD_PATTERNS: RegExp[] = [
  ...SENSITIVE_FIELD_PATTERNS,
  /^id$/i,
  /_id$/i,
  /uuid/i,
];

interface BodyFeatureAccumulator {
  fieldPaths: Set<string>;
  maskedFieldPaths: Set<string>;
  primitiveTypePaths: Map<string, BodyPrimitivePath>;
  arrayLengths: Map<string, BodyArrayFeature>;
  safeScalarHints: Map<string, BodyScalarHint>;
  nodeCount: number;
  truncated: boolean;
}

function createAccumulator(): BodyFeatureAccumulator {
  return {
    fieldPaths: new Set(),
    maskedFieldPaths: new Set(),
    primitiveTypePaths: new Map(),
    arrayLengths: new Map(),
    safeScalarHints: new Map(),
    nodeCount: 0,
    truncated: false,
  };
}

function rootKind(value: unknown): BodyRootKind {
  if (value === undefined) {
    return "absent";
  }
  if (value === null) {
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
    case "object":
      return "object";
    default:
      return "object";
  }
}

function primitiveType(value: unknown): BodyPrimitiveType | null {
  if (value === null || value === undefined) {
    return "null";
  }
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return null;
  }
}

function arrayLengthBucket(length: number): BodyArrayLengthBucket {
  if (length === 0) {
    return "0";
  }
  if (length === 1) {
    return "1";
  }
  if (length <= 5) {
    return "2-5";
  }
  if (length <= 20) {
    return "6-20";
  }
  if (length <= 100) {
    return "21-100";
  }
  return "101+";
}

function childPath(parentPath: string, key: string): string {
  return parentPath === "$" ? `$.${key}` : `${parentPath}.${key}`;
}

function arrayItemPath(path: string): string {
  return `${path}[]`;
}

function pathFieldNames(path: string): string[] {
  if (path === "$") {
    return [];
  }
  return path
    .replace(/^\$\./, "")
    .split(".")
    .map((segment) => segment.replace(/\[\]/g, ""));
}

function lastFieldName(path: string): string | null {
  const names = pathFieldNames(path);
  return names.length > 0 ? names[names.length - 1] : null;
}

function hasPatternMatch(path: string, patterns: RegExp[]): boolean {
  return pathFieldNames(path).some((fieldName) =>
    patterns.some((pattern) => pattern.test(fieldName))
  );
}

function isMaskedValue(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim();
  return MASKED_VALUE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isSafeEnumString(path: string, value: string): boolean {
  const fieldName = lastFieldName(path);
  if (!fieldName || !SAFE_STRING_FIELD_NAMES.has(fieldName)) {
    return false;
  }
  if (value.length === 0 || value.length > MAX_SAFE_STRING_LENGTH) {
    return false;
  }
  return /^[a-z0-9][a-z0-9_.:-]*$/i.test(value);
}

function numberHint(value: number): string {
  if (!Number.isFinite(value)) {
    return "non_finite";
  }
  if (!Number.isInteger(value)) {
    return "decimal";
  }
  if (value < 0) {
    return "negative";
  }
  if (value === 0) {
    return "zero";
  }
  if (value === 1) {
    return "one";
  }
  if (value <= 5) {
    return "2-5";
  }
  if (value <= 20) {
    return "6-20";
  }
  if (value <= 100) {
    return "21-100";
  }
  return "101+";
}

function addFieldPath(acc: BodyFeatureAccumulator, path: string): void {
  if (acc.fieldPaths.size >= MAX_FEATURE_PATHS) {
    acc.truncated = true;
    return;
  }
  acc.fieldPaths.add(path);
}

function addMaskedFieldPath(acc: BodyFeatureAccumulator, path: string): void {
  if (acc.maskedFieldPaths.size >= MAX_FEATURE_PATHS) {
    acc.truncated = true;
    return;
  }
  acc.maskedFieldPaths.add(path);
}

function addPrimitiveTypePath(
  acc: BodyFeatureAccumulator,
  path: string,
  type: BodyPrimitiveType
): void {
  if (acc.primitiveTypePaths.size >= MAX_FEATURE_PATHS) {
    acc.truncated = true;
    return;
  }
  acc.primitiveTypePaths.set(`${path}:${type}`, { path, type });
}

function addArrayLength(
  acc: BodyFeatureAccumulator,
  path: string,
  length: number
): void {
  if (acc.arrayLengths.size >= MAX_FEATURE_PATHS) {
    acc.truncated = true;
    return;
  }
  const bucket = arrayLengthBucket(length);
  acc.arrayLengths.set(`${path}:${length}:${bucket}`, { path, length, bucket });
}

function addSafeScalarHint(
  acc: BodyFeatureAccumulator,
  hint: BodyScalarHint
): void {
  if (acc.safeScalarHints.size >= MAX_FEATURE_PATHS) {
    acc.truncated = true;
    return;
  }
  acc.safeScalarHints.set(
    `${hint.path}:${hint.type}:${String(hint.hint)}`,
    hint
  );
}

function maybeAddSafeScalarHint(
  acc: BodyFeatureAccumulator,
  path: string,
  value: unknown,
  type: BodyPrimitiveType
): void {
  if (hasPatternMatch(path, UNSAFE_SCALAR_FIELD_PATTERNS)) {
    return;
  }

  switch (type) {
    case "boolean":
      addSafeScalarHint(acc, { path, type, hint: value as boolean });
      return;
    case "null":
      addSafeScalarHint(acc, { path, type, hint: null });
      return;
    case "number": {
      const fieldName = lastFieldName(path);
      if (fieldName && SAFE_NUMBER_FIELD_NAMES.has(fieldName)) {
        addSafeScalarHint(acc, { path, type, hint: numberHint(value as number) });
      }
      return;
    }
    case "string": {
      const stringValue = value as string;
      if (isSafeEnumString(path, stringValue)) {
        addSafeScalarHint(acc, { path, type, hint: stringValue });
      }
    }
  }
}

function visitBodyValue(
  value: unknown,
  path: string,
  depth: number,
  acc: BodyFeatureAccumulator
): void {
  acc.nodeCount++;
  if (acc.nodeCount > MAX_BODY_NODES || depth > MAX_BODY_DEPTH) {
    acc.truncated = true;
    return;
  }

  const type = primitiveType(value);
  if (type) {
    addPrimitiveTypePath(acc, path, type);
    if (isMaskedValue(value) || hasPatternMatch(path, SENSITIVE_FIELD_PATTERNS)) {
      addMaskedFieldPath(acc, path);
      return;
    }
    maybeAddSafeScalarHint(acc, path, value, type);
    return;
  }

  if (Array.isArray(value)) {
    addArrayLength(acc, path, value.length);
    const itemPath = arrayItemPath(path);
    for (const item of value.slice(0, MAX_ARRAY_ITEMS_TO_SCAN)) {
      visitBodyValue(item, itemPath, depth + 1, acc);
    }
    if (value.length > MAX_ARRAY_ITEMS_TO_SCAN) {
      acc.truncated = true;
    }
    return;
  }

  if (typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const pathForKey = childPath(path, key);
      addFieldPath(acc, pathForKey);
      if (hasPatternMatch(pathForKey, SENSITIVE_FIELD_PATTERNS)) {
        addMaskedFieldPath(acc, pathForKey);
      }
      visitBodyValue(
        (value as Record<string, unknown>)[key],
        pathForKey,
        depth + 1,
        acc
      );
    }
  }
}

function sortPrimitivePaths(paths: BodyPrimitivePath[]): BodyPrimitivePath[] {
  return paths.sort((a, b) =>
    a.path === b.path ? a.type.localeCompare(b.type) : a.path.localeCompare(b.path)
  );
}

function sortArrayFeatures(features: BodyArrayFeature[]): BodyArrayFeature[] {
  return features.sort((a, b) => {
    if (a.path !== b.path) {
      return a.path.localeCompare(b.path);
    }
    if (a.length !== b.length) {
      return a.length - b.length;
    }
    return a.bucket.localeCompare(b.bucket);
  });
}

function sortScalarHints(hints: BodyScalarHint[]): BodyScalarHint[] {
  return hints.sort((a, b) => {
    if (a.path !== b.path) {
      return a.path.localeCompare(b.path);
    }
    if (a.type !== b.type) {
      return a.type.localeCompare(b.type);
    }
    return String(a.hint).localeCompare(String(b.hint));
  });
}

function shapeHash(features: Omit<BodyFeatures, "shape_hash">): string {
  const hashInput = {
    kind: features.kind,
    field_paths: features.field_paths,
    masked_field_paths: features.masked_field_paths,
    primitive_type_paths: features.primitive_type_paths,
    array_lengths: features.array_lengths,
    truncated: features.truncated,
  };
  return createHash("sha256")
    .update(JSON.stringify(hashInput))
    .digest("hex")
    .slice(0, 16);
}

export function extractBodyFeatures(body: unknown): BodyFeatures {
  const kind = rootKind(body);
  if (kind === "absent") {
    return {
      present: false,
      kind,
      field_paths: [],
      masked_field_paths: [],
      primitive_type_paths: [],
      array_lengths: [],
      safe_scalar_hints: [],
      shape_hash: null,
      truncated: false,
    };
  }

  const acc = createAccumulator();
  visitBodyValue(body, "$", 0, acc);

  const featuresWithoutHash: Omit<BodyFeatures, "shape_hash"> = {
    present: true,
    kind,
    field_paths: [...acc.fieldPaths].sort(),
    masked_field_paths: [...acc.maskedFieldPaths].sort(),
    primitive_type_paths: sortPrimitivePaths([...acc.primitiveTypePaths.values()]),
    array_lengths: sortArrayFeatures([...acc.arrayLengths.values()]),
    safe_scalar_hints: sortScalarHints([...acc.safeScalarHints.values()]),
    truncated: acc.truncated,
  };

  return {
    ...featuresWithoutHash,
    shape_hash: shapeHash(featuresWithoutHash),
  };
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
    request_body_features: extractBodyFeatures(doc.request_payload),
    response_body_features: extractBodyFeatures(doc.response_body),
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
