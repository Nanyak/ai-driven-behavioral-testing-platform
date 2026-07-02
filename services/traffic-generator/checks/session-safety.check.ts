import assert from "node:assert/strict";

import { StoreSession } from "../src/api/store-session.js";
import type {
  ApiResponse,
  MedusaClient,
} from "../src/http/client.js";

interface CapturedRequest {
  method: string;
  path: string;
  options: { body?: unknown; token?: string };
}

function fakeClient(
  responses: ApiResponse[],
  captured: CapturedRequest[]
): MedusaClient {
  return {
    sessionId: "safety-check",
    async request(
      method: string,
      path: string,
      options: { body?: unknown; token?: string } = {}
    ): Promise<ApiResponse> {
      captured.push({ method, path, options });
      const response = responses.shift();
      assert.ok(response, `unexpected request: ${method} ${path}`);
      return response;
    },
  } as unknown as MedusaClient;
}

const registrationRequests: CapturedRequest[] = [];
const registrationSession = new StoreSession(
  fakeClient(
    [
      { status: 200, ok: true, body: { token: "registration-token" } },
      { status: 200, ok: true, body: { customer: { id: "cus_1" } } },
      { status: 200, ok: true, body: { token: "session-token" } },
    ],
    registrationRequests
  )
);

const registrationResult = await registrationSession.register();
assert.equal(registrationResult.ok, true);
assert.equal(registrationSession.token, "session-token");
assert.deepEqual(
  registrationSession.steps.map((step) => step.action),
  ["register", "create_customer", "login"]
);
assert.equal(registrationRequests[1].path, "/store/customers");
assert.equal(registrationRequests[1].options.token, "registration-token");
assert.equal(registrationRequests[2].path, "/auth/customer/emailpass");
assert.equal(registrationRequests[2].options.token, undefined);
assert.equal(
  registrationRequests.some(
    (request) =>
      request.path !== "/store/customers" &&
      request.options.token === "registration-token"
  ),
  false
);

const cartRequests: CapturedRequest[] = [];
const cartSession = new StoreSession(
  fakeClient(
    [{ status: 401, ok: false, body: { message: "Unauthorized" } }],
    cartRequests
  )
);
cartSession.useExistingToken("shopper@example.test", "expired-session-token");
cartSession.regionId = "reg_1";
cartSession.products = [{ id: "prod_1", variantId: "variant_1" }];

const cartResult = await cartSession.createCart();
assert.equal(cartResult.ok, false);
await cartSession.addItem();
assert.equal(cartRequests.length, 1, "a failed cart creation must not be retried");
assert.deepEqual(
  cartSession.steps.map((step) => [step.action, step.status]),
  [
    ["resume_session", 200],
    ["create_cart", 401],
    ["add_item", 0],
  ]
);

console.log("session safety checks passed");
