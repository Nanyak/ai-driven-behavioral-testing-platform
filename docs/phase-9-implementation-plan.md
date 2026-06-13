# Phase 9 — Script Generator

## Goal

Convert ranked test candidates from the behavior engine into runnable Playwright API tests (`.spec.ts`), one canonical test per selected flow, with runtime-resolved IDs, auth handling, status assertions, and golden-schema assertions.

> Framework note: the problem statement mentions Jest/Mocha; this project standardizes on Playwright's `request` context for API testing (plan §12). One runner, one report format.

> HITL scope: the HITL Review Dashboard phase (plan §16) operates on **flows and generated tests** — browse, approve, discard. Persona is **not** a control there; it is the read-only label carried over from Phase 7's emergent classification, used only to group/filter the test list. The MVP version is read-only; step editing and execution gating are optional extensions. See the "HITL scope" section in the Phase 7 plan.

## Location

```
services/script-generator/
  src/
    load.ts              # read behavior-engine candidates
    dedup.ts             # second-pass dedup/cluster/cap (defensive)
    templates/
      store-flow.ts.hbs  # guest/customer store-side test template
      admin-flow.ts.hbs  # admin test template
      edge-flow.ts.hbs   # edge-case (expect 4xx) template
    resolve.ts           # runtime ID/token resolution helpers emitted into tests
    emit.ts              # render templates -> .spec.ts files
    run.ts               # CLI entrypoint
generated-tests/
  guest/  customer/  admin/  edge/
  _golden/               # vendored copy of services/golden comparator (self-contained suite)
  playwright.config.ts
  fixtures/auth.ts       # shared admin login / publishable key fixtures
```

## Implementation steps

1. **Load candidates** from `services/behavior-engine/data/candidates/`.
2. **Defensive dedup** (candidates are already deduped in Phase 7, but re-apply): identical step sequences → highest support; common-prefix ≥3 → longest representative; cap 10 per persona.
3. **Per-flow generation.** One `.spec.ts` per canonical flow, grouped into `guest/ customer/ admin/ edge/` folders by emergent persona.
4. **Runtime resolution** (never hardcode seeded IDs):
   - product/variant IDs ← `GET /store/products` at test start
   - cart ID ← captured from `POST /store/carts` response
   - line-item ID ← captured from add-item response
   - customer token ← register/login within the test (customer flows)
   - admin token ← shared fixture `fixtures/auth.ts`
   - publishable key ← `process.env.MEDUSA_PUBLISHABLE_KEY`
5. **Assertions per step:**
   - status code assertion from candidate `expected_status`
   - golden-schema assertion via the Phase 8 `compare` utility (imported into the test) for steps that have a stored golden
   - edge-case templates assert the expected 4xx/5xx
6. **Sample payloads** come from the candidate's `request_payload` (captured from logs), making bodies realistic.
7. **Vendor the comparator.** Copy the Phase 8 golden comparator from the canonical `services/golden/src/` into `generated-tests/_golden/` on each generation run, so the suite is self-contained with no reach-back dependency on `services/`. Because the copy is regenerated every run, it never drifts from the source.
8. **Playwright config**: base URL from env, sensible timeouts, JSON + HTML reporters wired (consumed in Phase 10/11).

## Example emitted test (shape)

```ts
import { test, expect } from "@playwright/test";
import { assertGolden } from "../_golden/compare";

test("guest_shopper — create cart and add item", async ({ request }) => {
  const key = process.env.MEDUSA_PUBLISHABLE_KEY!;
  const products = await request.get("/store/products", { headers: { "x-publishable-api-key": key } });
  expect(products.status()).toBe(200);
  const variantId = (await products.json()).products[0].variants[0].id;

  const cart = await request.post("/store/carts", { headers: { "x-publishable-api-key": key } });
  expect(cart.status()).toBe(200);
  const cartId = (await cart.json()).cart.id;
  await assertGolden("POST /store/carts", 200, await cart.json());

  const add = await request.post(`/store/carts/${cartId}/line-items`, {
    headers: { "x-publishable-api-key": key },
    data: { variant_id: variantId, quantity: 1 },
  });
  expect(add.status()).toBe(200);
});
```

## Key decisions

- **One test per canonical flow** — clustering already happened upstream; the generator should not re-expand.
- **All IDs resolved at runtime** — tests must survive a reseed.
- **Golden comparator is vendored, not reached-back-to** — `services/golden` stays the single source of truth, but it is copied into `generated-tests/_golden/` each run so the generated suite is self-contained and portable.

## Validation / acceptance

- ≥5 `.spec.ts` files generated across personas.
- Generated files type-check / `playwright test --list` succeeds (syntactically valid, discoverable).
- `generated-tests/` is self-contained: tests import the comparator from `_golden/`, not from `services/`.
- Each test resolves its own IDs and tokens; no hardcoded seed IDs.
- Each test has at least a status assertion; store/admin flows also carry golden-schema assertions.
- Edge tests assert the expected error status.
