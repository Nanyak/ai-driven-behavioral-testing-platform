import assert from "node:assert/strict";

import {
  buildSessionFlows,
  collapseTransportNoise,
  groupBySession,
} from "../src/pipeline.js";
import type { RawLogDoc } from "../src/types.js";

function doc(
  timestamp: string,
  sessionId: string,
  method: string,
  endpoint: string,
  status: number,
  requestPayload?: unknown
): RawLogDoc {
  return {
    timestamp,
    session_id: sessionId,
    source: "medusa",
    method,
    endpoint,
    status,
    request_payload: requestPayload,
  };
}

const dashboard = [
  doc(
    "2026-07-03T00:00:00.000Z",
    "dashboard-status-session",
    "POST",
    "/auth/user/emailpass",
    200
  ),
  doc(
    "2026-07-03T00:00:00.010Z",
    "dashboard-status-session",
    "GET",
    "/store/products?limit=1",
    304
  ),
];
const behavioral = [
  doc("2026-07-03T00:00:01.000Z", "shopper-1", "GET", "/store/products", 200),
  doc("2026-07-03T00:00:01.050Z", "shopper-1", "GET", "/store/products", 304),
  doc(
    "2026-07-03T00:00:02.000Z",
    "shopper-1",
    "POST",
    "/store/carts",
    401,
    { region_id: "reg_1" }
  ),
  doc(
    "2026-07-03T00:00:02.100Z",
    "shopper-1",
    "POST",
    "/store/carts",
    401,
    { region_id: "reg_1" }
  ),
  doc(
    "2026-07-03T00:00:03.500Z",
    "shopper-1",
    "POST",
    "/store/carts/cart_1/line-items",
    200,
    { variant_id: "variant_1", quantity: 1 }
  ),
  doc(
    "2026-07-03T00:00:03.600Z",
    "shopper-1",
    "POST",
    "/store/carts/cart_1/line-items",
    200,
    { variant_id: "variant_1", quantity: 1 }
  ),
];

const grouped = groupBySession([...dashboard, ...behavioral]);
assert.equal(grouped.droppedDashboardProbe, 2);
assert.deepEqual(grouped.buckets.map((bucket) => bucket.sessionId), ["shopper-1"]);

const collapsed = collapseTransportNoise(behavioral);
assert.equal(collapsed.dropped, 2);
assert.deepEqual(
  collapsed.docs.map((entry) => entry.status),
  [200, 401, 200, 200],
  "cache/retry artifacts collapse while successful repeated actions remain"
);

const built = buildSessionFlows(grouped.buckets);
assert.equal(built.collapsedTransportNoise, 2);
assert.equal(built.sessions.length, 1);
assert.deepEqual(
  built.sessions[0].steps.map((step) => `${step.method} ${step.endpoint} ${step.status}`),
  [
    "GET /store/products 200",
    "POST /store/carts 401",
    "POST /store/carts/{id}/line-items 200",
    "POST /store/carts/{id}/line-items 200",
  ]
);

assert.equal(
  buildSessionFlows([
    { sessionId: "dashboard-status-session", docs: dashboard },
  ]).sessions.length,
  0,
  "the build stage independently rejects dashboard probes"
);

console.log("transport noise checks passed");
