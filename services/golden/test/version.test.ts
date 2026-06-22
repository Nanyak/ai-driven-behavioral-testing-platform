import { strict as assert } from "node:assert";
import { compareResponse } from "../src/compare.js";
import { checkOasDrift, decideRefresh, stampCapturedAt } from "../src/version.js";
import type { GoldenResponse } from "../src/types.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const golden: GoldenResponse = {
  endpoint: "POST /store/carts",
  expected_status: 200,
  expected_schema: { currency_code: "string", items: "array" },
  ignore_fields: ["id", "created_at", "updated_at"],
  schema_source: "openapi",
  oas_operation_id: "PostCarts",
  oas_ref: "#/components/schemas/StoreCart",
  oas_version: "2.0.0",
  captured_at: "2026-06-19T00:00:00.000Z",
  source_sessions: [],
};

check("stampCapturedAt produces an ISO-8601 timestamp", () => {
  const stamp = stampCapturedAt(new Date("2026-06-19T12:00:00Z"));
  assert.equal(stamp, "2026-06-19T12:00:00.000Z");
});

check("a passing comparison never triggers a refresh", () => {
  const result = compareResponse(golden, 200, { currency_code: "usd", items: [] });
  const decision = decideRefresh(result, false);
  assert.equal(decision.refresh, false);
});

check("an intentional schema change is flagged as a regression by default (no refresh)", () => {
  const result = compareResponse(golden, 200, { currency_code: "usd" });
  assert.equal(result.pass, false);
  const decision = decideRefresh(result, false);
  assert.equal(decision.refresh, false);
  assert.match(decision.reason, /regression/);
});

check("explicit refresh updates the baseline only when requested", () => {
  const result = compareResponse(golden, 200, { currency_code: "usd" });
  const decision = decideRefresh(result, true);
  assert.equal(decision.refresh, true);
});

check("checkOasDrift flags a golden whose oas_version no longer matches the current spec", () => {
  const flag = checkOasDrift(golden, "2.5.0");
  assert.equal(flag.drifted, true);
  assert.equal(flag.goldenVersion, "2.0.0");
});

check("checkOasDrift reports no drift when versions match", () => {
  const flag = checkOasDrift(golden, "2.0.0");
  assert.equal(flag.drifted, false);
});

check("checkOasDrift never flags an observed-only golden (no spec provenance)", () => {
  const observedOnly: GoldenResponse = { ...golden, schema_source: "observed", oas_version: null };
  const flag = checkOasDrift(observedOnly, "2.5.0");
  assert.equal(flag.drifted, false);
});

console.log(`\nversion.test: ${passed} checks passed`);
