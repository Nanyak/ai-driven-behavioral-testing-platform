import { strict as assert } from "node:assert";
import { matchesExactJourney } from "./hitl-store.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const routeA =
  "registered_customer|POST /store/carts > POST /store/carts/{id}/line-items";
const routeB =
  "registered_customer|POST /store/carts > POST /store/carts/{id}/shipping-methods";

check("an exact canonical signature matches despite missing route metadata", () => {
  assert.equal(
    matchesExactJourney(
      { flow_signature: "A".repeat(64) },
      { flow_signature: "a".repeat(64), route_key: routeA }
    ),
    true
  );
});

check("an exact persisted route matches legacy decisions with a different signature", () => {
  assert.equal(
    matchesExactJourney(
      { flow_signature: "a".repeat(64), route_key: routeA },
      { flow_signature: "b".repeat(64), route_key: routeA }
    ),
    true
  );
});

check("related scenario-family routes do not conflict or supersede one another", () => {
  assert.equal(
    matchesExactJourney(
      { flow_signature: "a".repeat(64), route_key: routeA },
      { flow_signature: "b".repeat(64), route_key: routeB }
    ),
    false
  );
});

console.log(`\n${passed} HITL journey-identity checks passed`);
