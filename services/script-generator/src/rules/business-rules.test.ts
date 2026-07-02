/**
 * Business-rules table unit tests (run: `tsx src/rules/business-rules.test.ts`).
 * Pure functions only. Asserts the table stays faithful to gate-contract.ts (the
 * single source of truth) and reproduces the precondition knowledge the planner
 * used to re-derive by hand.
 */
import assert from "node:assert/strict";
import {
  GATE_MATCHERS,
  GATE_METHODS,
  GATE_UNAUTHORIZED_STATUS,
  GATE_UNAUTHORIZED_BODY,
} from "../../../../apps/medusa/apps/backend/src/api/gate-contract.js";
import {
  preconditionsFor,
  requiresCustomerAuth,
  requiresAdminAuth,
  requiresCheckoutReadyCart,
  expectedRejectionFor,
  unsatisfiableReasonFor,
  isAuthGatedResourceVar,
  placeholderIdFor,
  expectsCustomerAuthRejection,
  mirrorFailureCandidatesFor,
  mintedFailureCandidates,
  CUSTOMER_AUTHENTICATED,
  CUSTOMER_AUTH_REJECTION_STATUS,
  BUSINESS_RULE_MINT_SOURCE,
  BUSINESS_RULES,
  type SkillKey,
} from "./business-rules.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// requiresCustomerAuth matches EXACTLY the gate matchers × gate methods.
check("requiresCustomerAuth matches the gate matchers", () => {
  for (const matcher of GATE_MATCHERS) {
    const base = matcher.replace(/\*$/, "");
    for (const method of GATE_METHODS) {
      assert.equal(requiresCustomerAuth(method, base), true, `${method} ${base}`);
      assert.equal(requiresCustomerAuth(method, `${base}/{id}/sub`), true, `${method} ${base}/{id}/sub`);
    }
  }
  // A GET on a gated path is NOT gated (GET is left open by GATE_METHODS).
  assert.equal(requiresCustomerAuth("GET", "/store/carts/{id}"), false);
  // A non-gated path is not gated.
  assert.equal(requiresCustomerAuth("POST", "/store/customers"), false);
  assert.equal(requiresCustomerAuth("GET", "/store/customers/me"), false);
});

// expectedRejectionFor returns the gate body/status, sourced from gate-contract.
check("expectedRejectionFor returns the gate rejection from gate-contract", () => {
  const rej = expectedRejectionFor("POST", "/store/carts", CUSTOMER_AUTHENTICATED);
  assert.ok(rej, "a gated mutation has an expected rejection");
  assert.equal(rej.status, GATE_UNAUTHORIZED_STATUS);
  assert.equal(rej.bodyMatcher.expected, GATE_UNAUTHORIZED_BODY);
  assert.equal(rej.bodyMatcher.matches(GATE_UNAUTHORIZED_BODY), true);
  assert.equal(rej.bodyMatcher.matches({ type: "other", message: "x" }), false);
  assert.equal(rej.bodyMatcher.matches(null), false);
  assert.equal(rej.bodyMatcher.matches("nope"), false);
  // No rejection for a precondition the endpoint doesn't carry.
  const admin: SkillKey = { entity: "admin", state: "authenticated" };
  assert.equal(expectedRejectionFor("POST", "/store/carts", admin), null);
});

// The gate constants this module reads MUST equal gate-contract.ts (no drift).
check("gate constants match gate-contract.ts", () => {
  assert.equal(CUSTOMER_AUTH_REJECTION_STATUS, GATE_UNAUTHORIZED_STATUS);
  const gateRule = BUSINESS_RULES.find((r) => r.id === "customer-auth-gate");
  assert.ok(gateRule);
  assert.deepEqual([...gateRule.patterns], [...GATE_MATCHERS]);
  assert.deepEqual([...gateRule.methods], [...GATE_METHODS]);
  assert.equal(gateRule.expectedRejection?.status, GATE_UNAUTHORIZED_STATUS);
  assert.equal(gateRule.expectedRejection?.bodyMatcher.expected, GATE_UNAUTHORIZED_BODY);
});

check("requiresAdminAuth matches /admin/* on every method", () => {
  assert.equal(requiresAdminAuth("GET", "/admin/orders"), true);
  assert.equal(requiresAdminAuth("POST", "/admin/products"), true);
  assert.equal(requiresAdminAuth("DELETE", "/admin/orders/{id}"), true);
  assert.equal(requiresAdminAuth("GET", "/store/products"), false);
  assert.equal(requiresAdminAuth("POST", "/auth/user/emailpass"), false);
});

check("requiresCheckoutReadyCart is exactly POST /store/carts/{id}/complete", () => {
  assert.equal(requiresCheckoutReadyCart("POST", "/store/carts/{id}/complete"), true);
  assert.equal(requiresCheckoutReadyCart("GET", "/store/carts/{id}/complete"), false);
  assert.equal(requiresCheckoutReadyCart("POST", "/store/carts/{id}"), false);
  assert.equal(requiresCheckoutReadyCart("POST", "/store/carts/{id}/line-items"), false);
});

check("preconditionsFor unions matching rules (complete carries auth + checkout-ready)", () => {
  const pres = preconditionsFor("POST", "/store/carts/{id}/complete");
  assert.equal(pres.some((k) => k.entity === "customer" && k.state === "authenticated"), true);
  assert.equal(pres.some((k) => k.entity === "cart" && k.state === "checkout-ready"), true);
  // De-duplicated: customer-auth appears once even though two rules match.
  assert.equal(pres.filter((k) => k.entity === "customer" && k.state === "authenticated").length, 1);
});

check("isAuthGatedResourceVar / placeholderIdFor cover cart + payment collection", () => {
  assert.equal(isAuthGatedResourceVar("cartId"), true);
  assert.equal(isAuthGatedResourceVar("paymentCollectionId"), true);
  assert.equal(isAuthGatedResourceVar("productId"), false);
  assert.equal(placeholderIdFor("cartId"), "cart_unauthorized");
  assert.equal(placeholderIdFor("paymentCollectionId"), "paycol_unauthorized");
  assert.equal(placeholderIdFor("somethingElse"), "somethingElse_unauthorized");
});

check("expectsCustomerAuthRejection fires only for a customer token at the gate status", () => {
  assert.equal(expectsCustomerAuthRejection("customer-token", GATE_UNAUTHORIZED_STATUS), true);
  assert.equal(expectsCustomerAuthRejection("customer-token", 400), false);
  assert.equal(expectsCustomerAuthRejection("publishable-key", GATE_UNAUTHORIZED_STATUS), false);
  assert.equal(expectsCustomerAuthRejection("admin-token", GATE_UNAUTHORIZED_STATUS), false);
});

check("unsatisfiableReasonFor sources the drop reason for gated mutations", () => {
  const reason = unsatisfiableReasonFor("POST", "/store/carts");
  assert.ok(reason && /requireCustomerAuth/.test(reason));
  assert.equal(unsatisfiableReasonFor("GET", "/store/products"), null);
});

check("mirrorFailureCandidatesFor mints one guest negative per failureMint", () => {
  const gate = BUSINESS_RULES.find((r) => r.id === "customer-auth-gate")!;
  const minted = mirrorFailureCandidatesFor(gate);
  assert.equal(minted.length, gate.failureMints!.length);
  for (const c of minted) {
    assert.equal(c.persona, "guest_shopper");
    assert.equal(c.persona_source, BUSINESS_RULE_MINT_SOURCE);
    assert.equal(c.attributes.has_errors, true);
    assert.equal(c.attributes.requires_auth, false);
    assert.equal(c.steps.length, 1);
    // The asserted status is the gate rejection, sourced from gate-contract.ts.
    assert.equal(c.steps[0].expected_status, CUSTOMER_AUTH_REJECTION_STATUS);
  }
  // Signatures are stable and distinct (they become the spec filenames).
  const sigs = new Set(minted.map((c) => c.signature));
  assert.equal(sigs.size, minted.length);
});

check("a rule with no expectedRejection or no failureMints mints nothing", () => {
  const admin = BUSINESS_RULES.find((r) => r.id === "admin-token")!;
  assert.deepEqual(mirrorFailureCandidatesFor(admin), []);
});

check("mintedFailureCandidates aggregates across the table", () => {
  const all = mintedFailureCandidates();
  assert.ok(all.length >= 3, "expected at least the three customer-auth-gate mints");
  assert.ok(all.every((c) => c.persona_source === BUSINESS_RULE_MINT_SOURCE));
});

console.log(`\n${passed} business-rules checks passed`);
