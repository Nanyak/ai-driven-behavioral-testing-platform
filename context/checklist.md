# Implementation Checklist

## Phase 0: Project Setup

- [x] Review `plan.md` and confirm Medusa is the selected backend system under test.
- [x] Define the local development requirements: Node.js, package manager, Docker, Docker Compose, and PostgreSQL.
- [x] Create the initial project folder structure.
- [x] Decide whether all platform services will be written in TypeScript or whether Python will be used for behavioral analysis.
- [x] Prepare a `.env.example` file for shared environment variables.
- [x] Document the expected local ports for Medusa, Elasticsearch, Kibana, and supporting services.

## Phase 1: Medusa Initialization

- [x] Create a Medusa project under `apps/medusa`.
- [x] Configure the Medusa database.
- [x] Configure Redis if required by the selected Medusa setup.
- [x] Start Medusa locally.
- [x] Verify the health endpoint or basic API availability.
- [x] Seed basic product data.
- [x] Configure regions, currency, shipping option, and mock payment provider.
- [x] Create an admin user.
- [x] Generate or retrieve a publishable API key for Store APIs.
- [x] Verify Store API access with a request such as `GET /store/products`.
- [x] Verify Admin API authentication.

## Phase 2: Structured Logging

- [x] Add request logging middleware to Medusa.
- [x] Capture request timestamp.
- [x] Capture HTTP method.
- [x] Capture raw endpoint.
- [x] Capture normalized endpoint.
- [x] Capture request payload.
- [x] Capture response code.
- [x] Capture reduced or normalized response body.
- [x] Capture request duration in milliseconds.
- [x] Generate `trace_id` if it is missing.
- [x] Read `session_id` from a header or cookie.
- [x] Log `user_role` from JWT `actor_type` (`null` for unauthenticated guests).
- [x] Capture user role when available.
- [x] Capture user/customer/admin ID when available.
- [x] Mask passwords, tokens, secrets, and other sensitive values.
- [x] Emit logs as JSON lines.
- [x] Confirm logs are readable from stdout or a log file.

## Phase 2.1: Docker Compose App Development

- [x] Create root `docker-compose.yml`.
- [x] Add a Medusa app service for local development.
- [x] Add PostgreSQL 15 and Redis 7 dependency services.
- [x] Expose Medusa on port `9000`.
- [x] Bind mount `apps/medusa` into the Medusa container.
- [x] Keep container dependencies in named Docker volumes.
- [x] Configure container `DATABASE_URL` and `REDIS_URL` to use Compose service names.
- [x] Mount the root `.env` over the container backend `.env`.
- [x] Run Medusa database setup and seed scripts before the app starts in Compose.
- [x] Mount host logs so structured JSONL output remains readable from the workspace.
- [x] Add root Compose helper scripts.
- [x] Document Compose start, stop, and Medusa Admin URL.

## Phase 3: Storefront And Platform Dashboard

- [x] Create `apps/storefront`.
- [x] Configure Storefront Medusa base URL.
- [x] Configure Storefront publishable API key.
- [x] Display seeded products from `GET /store/products`.
- [x] Display a product detail view.
- [x] Create a cart from the storefront.
- [x] Add a selected variant to the cart.
- [x] Show basic cart item count and cart contents.
- [x] Add storefront customer registration and login.
- [x] Add storefront customer profile check and logout.
- [x] Add storefront cart readiness checks for shipping and payment.
- [x] Add storefront checkout flow through cart completion.
- [x] Redesign storefront UI: clean neutral palette, new CSS-gradient hero (no external image), rounded-2xl cards, slate-900 headings, improved hover transitions.
- [x] Create `apps/platform-dashboard`.
- [x] Show Medusa backend health/status.
- [x] Show Store API availability.
- [x] Show Admin API authentication availability.
- [x] Link to Medusa Admin at `http://localhost:9000/app`.
- [x] Link to the storefront.
- [x] Add dashboard placeholders for logs, traffic generation, behavior flows, generated tests, and reports.
- [x] Document expected frontend ports.
- [x] Verify both frontend apps can start locally.

## Phase 4: ELK Integration

- [x] Create `infra/docker-compose.yml`.
- [x] Add Elasticsearch service.
- [x] Add Kibana service.
- [x] Add Logstash or Filebeat service.
- [x] Configure Elasticsearch as a single-node local instance.
- [x] Configure memory limits for local development.
- [x] Configure Logstash/Filebeat to ingest Medusa JSON logs.
- [x] Create an index pattern such as `behavior-logs-*`.
- [x] Verify logs are indexed in Elasticsearch.
- [x] Verify logs are visible and searchable in Kibana.
- [x] Test filtering logs by `session_id`.
- [x] Test filtering logs by `user_role` (logs carry no persona field; persona is emergent — see Phase 7 and plan §10.3).
- [x] Test filtering logs by `status` (response code).

## Phase 5: Synthetic Traffic Generator

- [x] Create `services/traffic-generator`.
- [x] Add shared HTTP client configuration.
- [x] Add Medusa base URL configuration.
- [x] Add publishable API key configuration.
- [x] Add admin credentials configuration.
- [x] Implement helper for generating `session_id`.
- [x] Implement helper for generating `trace_id`.
- [x] Attach `session_id` and `trace_id` headers to all outgoing requests (no persona header).

> Note: the items below were originally written against the first-cut **flat
> mix** (fixed 35-guest / 20-admin / 20-llm / 10-noise / 20-edge budgets). The
> generator has since been rebuilt onto the **staged situation taxonomy** (see
> the subsection after Validation). Fixed-count budgets are superseded by the
> profile weights (§4) + floors (§7); live-stack validation is re-pending under
> the staged build because the flows were materially rewritten.

Scripted flows:

- [x] Implement Guest Shopper scripted flow (now intent-driven: bounce / browse / cart-abandon / checkout-abandon / buy).
- [x] Implement Admin Operator scripted flow (catalog; + fulfill / refund / support added in Stage 2).
- [x] Guest & admin session counts are now profile-weighted over the §4 taxonomy with §7 floors (replaces the fixed 35 / 20 budgets).

LLM-varied flows (holdout):

- [x] Implement LLM prompt to generate realistic session narratives using the Claude API (Haiku 4.5, `claude-haiku-4-5-20251001`).
- [x] Translate LLM-generated narratives into API call sequences.
- [x] Implement Registered Customer (register→login→checkout) flow from LLM-varied output only (no scripted equivalent).
- [x] Confirm **in code** the Registered Customer full checkout sequence lives only in `personas/`, never in `flows/`.
- [x] Floor top-up enforces ≥6 completed holdout checkouts (config `MIN_HOLDOUT`); observed count confirmed by the end-to-end run item below.

Noise injection (now woven into flows, not a fixed budget):

- [x] Implement abandoned flow: cut sessions short at a realistic step (per §4.1 abandonment shape).
- [x] Implement retry noise: repeat a failing call with corrected or incorrect input after a 4xx response.
- [x] Implement persona contamination: occasionally include out-of-persona endpoint calls within a session.
- [x] Implement random step shuffling for browsing sequences (product list / product detail ordering).

Edge-case flow:

- [x] Implement Edge Case User flow (unauthenticated admin call, invalid cart ID, invalid payload).
- [x] Edge sessions are the §4 G leaf (profile-weighted, ~2%), replacing the fixed 20-session budget.

Validation (require the live stack — re-pending under the staged build; the ES → Logstash plumbing is unchanged from when the flat-mix build last confirmed these):

- [ ] Confirm generated traffic appears in Medusa logs.
- [ ] Confirm generated traffic appears in Elasticsearch (including the new return / refund / fulfillment / profile / search events).
- [ ] Confirm the realized session mix is reflected in the spread of log `user_role` and `session_id` fields (no persona field is logged).
- [x] Registered Customer checkout sequence exists only in `personas/customer-llm.ts` with no corresponding scripted flow (verified in code).

Staged situation taxonomy (plan §4–§7 — supersedes the flat mix above):

- [x] Implement `state.ts` (`RunState`: account / order / return pools, valid promo).
- [x] Implement `taxonomy.ts` (weighted allocation, identity split, stage map, identity assignment).
- [x] Add `MIX_PROFILE` (realistic / signal-rich / smoke), `TRAFFIC_TOTAL_SESSIONS`, `ACCOUNT_POOL_SIZE`, promo-code config.
- [x] Decouple sign-in from sign-up: `loginExisting` (login-only) + Stage-0 signup-only sessions (register without checkout).
- [x] Implement returning-customer flow (`flows/returning.ts`, login-only, not the holdout).
- [x] Implement order-status + profile/address management (`flows/account.ts`, D1/D2).
- [x] Implement customer return flow (`flows/returns.ts`, E) referencing a real pooled order.
- [x] Implement admin fulfill / refund / support flows (F2/F3/F4).
- [x] Implement Stage 0 (seed promo + account pool) → Stage 1 (browse & buy) → Stage 2 (post-purchase) orchestrator with floor top-up.
- [x] Stage 2 hard-fails loudly on an empty order pool.
- [x] Print observed-vs-target distribution + acceptance-gate report (holdout, checkouts, returns, linked refunds, promo, decoupling).
- [x] **VERIFIED against live Medusa 2.15.5:** `POST /admin/promotions` order-level body (`application_method` `target_type:"order"`, `allocation:"across"`) returns **200** — the old "promotions 400" note was stale; a 400 now only means the code already exists (re-run idempotency). The admin return lifecycle (begin+location → request-items → request → receive → receive-items → receive/confirm) and `POST /admin/orders/{id}/fulfillments` are confirmed working; `POST /admin/returns/{id}/cancel` (return-reject, Theme 4c) returns **200 with an empty body** (the per-item `{items}` body 400s — "Unrecognized fields"). `POST /store/returns` stays dead (no seed return-shipping option, ADR 0003). Version-sensitive calls still degrade to a logged non-2xx.
- [ ] Run end-to-end against the running stack and confirm the acceptance gates clear (≥6 holdout, ≥5 linked refunds, floors met).

## Phase 6: Data Ingestion Service

- [x] Create `services/log-ingestion`.
- [x] Add Elasticsearch client configuration.
- [x] Query logs by time range.
- [x] Query logs by `source = medusa`.
- [x] Group logs by `session_id`.
- [x] Sort grouped logs by timestamp.
- [x] Normalize dynamic URL segments.
- [x] Remove noisy or irrelevant endpoints.
- [x] Convert logs into behavioral sequence records.
- [x] Store extracted session flows as JSON.
- [x] Extract candidate golden responses using the schema-extraction algorithm defined in Phase 8 (plan §11.1).
- [x] Store golden responses under `golden-responses/`.
- [x] Add a command to run ingestion from the terminal.
- [x] Verify at least 50 sessions can be processed.

> Validated offline against the real Phase-5 log file (`logs/medusa-json.log`,
> bodies-off): **104 session flows** from 106 buckets, all endpoints normalized,
> noise removed, `role_observed` present, no persona field. `npm run check:phase6`
> passes (9/9). Golden extraction is exercised by a bodies-on fixture (the
> bodies-off prod log legitimately yields 0 goldens — ADR 0001). Re-runnable
> against the live ELK stack with `npm run ingest:run` once Elasticsearch is up.

## Phase 7: Behavioral Modeling Engine

- [x] Create `services/behavior-engine`.
- [x] Load session flows from ingestion output.
- [x] Mine flows from the raw, unlabeled sequence stream (do not pre-label sessions by persona).
- [x] Derive deterministic flow attributes from step content: `requires_auth` (contains `/auth/customer/*` or `/store/customers`, **or** a successful 2xx cart/checkout mutation on `/store/carts`/`/store/payment-collections` — carts are auth-gated, ADR 0003), `is_admin` (contains `/admin/*`), `has_errors` (contains 4xx/5xx).
- [x] Resolve persona from attributes: `is_admin` → admin_operator; `requires_auth` and not admin → registered_customer; neither → guest_shopper; `has_errors` as an orthogonal edge-case overlay.
- [x] Resolve mid-session role changes by highest-privilege attribute reached (admin > customer > guest).
- [x] Keep JWT `user_role` only as held-out ground truth for validation, never as classifier input.
- [x] Add `persona_source: "emergent_attributes"` field to flow output.
- [x] Identify Guest Shopper flows.
- [x] Identify Registered Customer flows.
- [x] Identify Admin Operator flows.
- [x] Identify Edge Case User flows.
- [x] Count endpoint sequence frequency.
- [x] Implement simple n-gram sequence mining.
- [x] Implement PrefixSpan frequent sequential pattern mining.
- [x] Configure minimum support threshold for PrefixSpan.
- [x] Prune duplicate or subsumed flows.
- [x] Implement a single canonical flow-signature function (`signature.ts`): stable hash of the normalized `METHOD endpoint` step sequence, persona-independent (ADR 0002), consecutive duplicates collapsed (PO-3); reuse it in dedup, the skip gate, and Phase 9 emit. Golden test in `signature.test.ts`.
- [x] Deduplicate flows with identical normalized step sequences (keep highest-support).
- [x] Cluster flows sharing a common prefix of three or more steps (keep longest representative).
- [x] Cap output at ten canonical flows per persona.
- [x] Implement the cross-run coverage manifest (`coverage.ts`): collect already-covered signatures from `generated-tests/**/*.spec.ts` and the HITL approval store (approved + discarded); a missing dir/store is an empty manifest, never an error (PO-6).
- [x] Apply the cross-run skip gate after ranking and before LLM naming: drop ranked flows whose signature is already covered (ADR 0002).
- [x] Report `skipped_existing` count in the run summary.
- [x] Compare n-gram output against PrefixSpan output.
- [x] Identify the top frequent flows.
- [x] Identify important error flows based on `4xx` and `5xx` responses.
- [x] Rank candidates by support, persona, endpoint/business importance (merged, PO-7), and error coverage; deterministic ordering (PO-5).
- [x] Produce test candidate JSON.
- [x] Verify at least five test candidates are generated from mined behavior flows.
- [x] Verify the Registered Customer checkout flow is discovered despite not being present in scripted sessions (holdout validation).
- [x] Score emergent persona classification against JWT `user_role` ground truth (report precision/recall per persona, both rule variants).
- [x] Report holdout recovery as a support count (Registered Customer checkout sequence support ≥ 6, the Phase 5 holdout floor), not a binary.
- [x] Add a negative control: concrete fixture confirming no un-injected flow (successful `POST /store/returns`, admin→customer-checkout chimera) is reported as high-support.
- [x] Use the LLM (Sonnet 4.6 by default, `BEHAVIOR_LLM_MODEL` configurable; key/model loaded from `services/behavior-engine/.env`) for flow naming, anomaly/contamination detection, and assertion recommendation — advisory only, never classification (ADR 0001).

## Phase 8: Golden Response Handling

- [x] Define the golden response JSON format (endpoint, expected_status, expected_schema, ignore_fields, schema_source, oas_operation_id, oas_ref, oas_version, captured_at, source_sessions).
- [x] Define the global ignore-fields list (id, created_at, updated_at, deleted_at, metadata, token, cart_id, order_id, trace_id, session_id).
- [x] Build the augmented spec (`build-oas.ts`, ADR 0004): overlay the middleware-injected gate `401` onto the read-only base Medusa OAS; deterministic union on status collisions, no LLM. (No ADR 0003 admin-reversal fragment is injected — the real Medusa admin base already documents the full reversal surface, so there is nothing supplemental to add; the admin-only policy lives in ADR 0003 + storefront/gate, not in spec annotations.)
- [x] Extract the shared gate-config module (matchers/methods/`GateUnauthorized`) imported by both `middlewares.ts` (enforce) and `build-oas.ts` (document) so enforcement and spec cannot drift.
- [x] Load the augmented OpenAPI spec and resolve `$ref` into typed per-(operation, status) schemas — the authoritative oracle (ADR 0001 / ADR 0004).
- [x] Source `expected_status` from the spec for happy-path steps and for error steps the overlay documents (with provenance); fall back to the observed status only where the spec has no entry.
- [x] Implement schema extraction: walk observed response JSON tree and classify leaf types (observed half of the intersection).
- [x] Intersect the OAS skeleton with observed schemas to tighten under-specified fields; stamp `schema_source` (`openapi` / `openapi+observed` / `observed`).
- [x] Stamp OAS provenance on spec-sourced goldens (`oas_operation_id`, `oas_ref`, `oas_version`) for traceability and drift detection.
- [x] Confirm a valid spec-only golden is produced with bodies off (oracle works without logged bodies).
- [x] Implement merge logic for optional fields across multiple sessions of the same endpoint.
- [x] Normalize response bodies before comparison (strip ignored fields).
- [x] Add schema comparison utility.
- [x] Add golden response comparison utility.
- [x] Implement versioning: store golden responses with a `captured_at` timestamp; require explicit refresh to update baseline.
- [x] Test comparison with a matching response.
- [x] Test comparison with a changed response code.
- [x] Test comparison with a changed response schema (new field added, field removed, type changed).
- [x] Confirm dynamic fields do not cause false failures.
- [x] Confirm an intentional schema change is detected as a regression.

> Implemented as a new `services/golden` library (mirrors behavior-engine's
> setup: ESM, ESNext/Bundler tsconfig, strict, tsx). The shared gate-contract
> module (`apps/medusa/apps/backend/src/api/gate-contract.ts`) is now imported
> by both `middlewares.ts` (enforce) and `services/golden/openapi/build-oas.ts`
> (document) — `middlewares.ts` was refactored surgically to import the
> matchers/methods/envelope instead of inline literals; behavior unchanged.
> Backend `tsc --noEmit` (`apps/medusa/apps/backend`) passes clean after the
> refactor (full Medusa-app typecheck, run directly — confirmed exit 0).
>
> The base OAS (`openapi/base/{store,admin}.json`) is the **real, published
> Medusa v2 OpenAPI spec** — not a fixture. Medusa publishes Store/Admin as a
> split spec (root `openapi.yaml` + external `$ref`s to per-schema YAML
> files); `openapi/fetch-base-oas.ts` bundles each into one self-contained
> JSON via a pinned `@redocly/cli bundle` (this is the only networked step in
> the package — `build-oas.ts` and `check:phase8` are fully offline against
> the committed `base/`). Committed: Store — 923,509 bytes, 63 paths, 109
> schemas; Admin — 4,592,454 bytes, 255 paths, 468 schemas; both report
> `info.version: "2.0.0"` (the spec's own version, independent of the
> `@medusajs/medusa` npm package version).
>
> Because the real spec already documents a `401` on every gated cart/
> payment-collection operation (Medusa's own shared `unauthorized` response),
> the ADR 0004 overlay exercises the `oneOf` **union** collision path on all
> 16 real gated ops — never a fresh add. The pure-add branch is still real
> overlay logic, so it stays covered via a small synthetic in-memory
> `OasDocument` in `build-oas.test.ts`, kept in a clearly labeled section
> separate from the real-data assertions. Real data also required handling
> response-level `$ref`s into shared `components/responses/*` (not inlined
> per-operation, must not be mutated in place) and `allOf` composition
> (`StoreProductListResponse`) — see `services/golden/README.md` for detail.
>
> `npm run check:phase8` passes 10/10: tsc clean, all 9 `services/golden`
> test files (56 checks) pass, the overlay's union (not overwrite) is
> confirmed on three representative gated ops plus GET-is-untouched, the
> rebuild is byte-identical, and `$ref` resolution is confirmed for
> `POST /store/carts` (-> `StoreCartResponse` -> `{ cart: $ref StoreCart }`)
> and `GET /store/products` (-> `StoreProductListResponse`, `allOf`) against
> the real augmented spec. End-to-end wiring that reads Phase 6
> `GoldenCandidate` output and writes files into `golden-responses/` is
> deferred to whichever later phase runs ingestion + golden generation
> together (Phase 9/11 consume `compare.ts` directly); this phase ships and
> unit-tests the algorithm in full, including an in-process end-to-end test
> (`golden-production.test.ts`).

## Phase 9: Script Generator

- [x] Create `services/script-generator`.
- [x] Read test candidates from the behavior engine (newest `test-candidates-*.json` by filename timestamp).
- [x] Deduplicate candidates: remove identical step sequences, keep highest-support representative.
- [x] Cluster candidates by common prefix (three or more steps); keep longest representative per cluster.
- [x] Cap at ten canonical tests per persona.
- [x] Generate Playwright `.spec.ts` files.
- [x] Generate one test per selected behavior flow.
- [x] Add Playwright project configuration (`generated-tests/playwright.config.ts`).
- [x] Add base URL configuration (`MEDUSA_BASE_URL` env, default `localhost:9000`).
- [x] Add publishable API key handling (`x-publishable-api-key` header, store calls).
- [x] Add admin authentication handling (`fixtures/auth.ts` shared login; skipped when a flow already logs in itself).
- [x] Resolve product IDs at runtime (no hardcoded seed IDs anywhere in emitted specs).
- [x] Resolve variant IDs at runtime.
- [x] Resolve cart IDs at runtime (including a `GET /store/regions` → `POST /store/carts` bootstrap chain for flow fragments that start mid-sequence).
- [x] Resolve customer/admin tokens at runtime.
- [x] Add status code assertions.
- [x] Add schema or golden response assertions (`assertGolden`, no-ops gracefully — `golden-responses/` is empty by design until bodies-on data exists).
- [x] Derive each test filename from the canonical flow signature (`<persona>/<short-hash>.spec.ts`) so regeneration is idempotent (ADR 0002).
- [x] Stamp the flow signature into each generated test (annotation / header comment) so the corpus is self-describing for the Phase 7 skip gate.
- [x] Reuse the Phase 7 `signature.ts` in the defensive dedup re-pass (no second "same flow?" key).
- [x] Write generated tests to `generated-tests/`.
- [x] Verify generated tests are syntactically valid (`tsc --noEmit` + `playwright test --list`, both clean — `npm run check:phase9`).

Note: mid-sequence fragments that reference a runtime-created resource with no
creator step in the fragment are emitted as `test.fixme` (reported in the run
summary, never silently dropped). **Fixed 2026-06-21:** body-field ID resolution
now goes through the same `ensure()`/bootstrap path as path and query params, so a
customer `POST /store/payment-collections` fragment whose `cart_id` lives only in
the body now bootstraps a real cart (`regions → carts`) and runs **green live**
instead of `test.fixme` (verified: `0f4a847541cd` and two more customer specs pass
against live Medusa). Remaining `test.fixme`: fragments starting at
`POST /store/carts/{id}/shipping-methods` (needs `shippingOptionId`) or
`POST /store/payment-collections/{id}/payment-sessions` (needs `paymentCollectionId`
in the path + `paymentProviderId` in the body) — those resolvers need a
query-param-bearing bootstrap GET and are tracked as follow-up. The live suite run
(Phase 10) is now done; see Phase 10/14 notes. None of these reach a customer
`POST /store/carts/{id}/complete` — that step is absent from every customer
candidate (a mining-surface issue, not a generator one), which is why the live
regression red-flip is shown via traffic+ES rather than a generated spec.

## Phase 10: Test Execution

- [x] Create `services/test-runner`.
- [x] Add command for running generated Playwright tests. (`npm run test:all`)
- [x] Add command for running only guest tests. (`npm run test:guest` → `--project guest`)
- [x] Add command for running only customer tests. (`npm run test:customer`)
- [x] Add command for running only admin tests. (`npm run test:admin`)
- [x] Add command for running only edge-case tests. (`npm run test:edge`)
- [x] Capture Playwright JSON output. (`reports/playwright/results.json`)
- [x] Capture Playwright HTML report. (`reports/playwright/html/`)
- [x] Confirm generated tests run against Medusa. (`npm run check:phase10` runs `test:edge` live when `:9000/health` is up; gracefully skipped when down)
- [x] Confirm failed assertions are reported clearly. (`failure.ts` prints expected-vs-actual status + a readable golden diff, not a raw object dump)

`collect.ts` normalizes the Playwright JSON into a persona→flow→step run result
(`reports/playwright/normalized.json`) that is Phase 11's input — capturing
persona, flow, endpoint, expected/actual status, golden diff, duration, and
source session ids. `trace_id` is **optional** (absent upstream — never
invented; see the Phase 11 note below). Verify: `npm run check:phase10`.

## Phase 11: Reporting

- [x] Create `reports/` output directory.
- [x] Define report JSON schema (`services/test-runner/src/report/schema.ts`).
- [x] Include total tests executed.
- [x] Include passed and failed test counts.
- [x] Include persona-level results (`by_persona`).
- [x] Include flow-level results (`by_flow`, keyed by flow signature, ADR 0002).
- [x] Include endpoint-level failures (`endpoint_failures`, sorted desc — drives the "most-failing endpoint" callout).
- [x] Include expected vs actual status code (per failing step).
- [x] Include golden response diff (rolled up to `{ missing, unexpected, type_changed }` per plan §schema).
- [x] Include source `session_id`. (carried as `source_sessions` on each failure — always present)
- [x] Include source `trace_id`. **Note (Phase 10 audit):** `trace_id` does not exist upstream — candidates carry `source_sessions` but no trace id, and steps are only method/endpoint/expected_status. The report builder carries `trace_id` **only when an upstream annotation supplies one, and omits it otherwise (never invents one)**. Confirmed: the failure entry has no `trace_id` key on the current corpus.
- [x] Generate `reports/report.json` (`report/build.ts` + `report/write.ts`).
- [x] Generate `reports/report.html` (`report/html.ts` — single self-contained file, inline CSS, no `<link>`/`<script>`).
- [x] Verify the report can be opened locally (double-click; validated by `npm run check:phase11`).

> Reporting lives in `services/test-runner/src/report/` (`schema.ts`, `build.ts`,
> `html.ts`, `summary.ts`, `write.ts`) and is wired into the runner CLI — every
> `npm run test:*` ends by writing `reports/report.json` + `reports/report.html`
> and printing a red/green console summary. `npm run check:phase11` proves it
> **offline** (10/10): tsc clean; `buildReport` aggregates the committed
> normalized fixture into totals/persona/flow/endpoint rollups; the failure
> entry cites persona/flow/endpoint/expected-vs-actual/golden-diff/source
> sessions; `report.html` is self-contained. No live stack required.

## Phase 12: Regression Demonstration

- [x] Create a controlled regression scenario (response-code regression, scenario A).
- [x] Change one response code in Medusa — `regressionDemoFault` middleware forces `POST /store/carts/{id}/complete` → 500 when `REGRESSION_DEMO=carts_complete_500` (OFF by default, reversible by env var).
- [x] Re-run generated tests **live** — **done 2026-06-22, generated spec flips green→red→green.** A `registered_customer` checkout spec (e.g. `customer/00811de2ead8.spec.ts`) runs the full authenticated checkout against live Medusa and returns `POST /store/carts/{id}/complete` **200 at baseline (GREEN)**; with `REGRESSION_DEMO=carts_complete_500` it goes **RED (Expected 200 / Received 500)**; revert → GREEN. The report attributes it: status red, most-failing endpoint `POST /store/carts/{id}/complete` (200→500), persona `registered_customer`. Closing the earlier gap took behavior-engine fixes (contiguous-subsequence subsumption + cap-after-rank + per-flow modal status + balanced clean/error cap, so the full checkout journey surfaces as a candidate) and script-generator fixes (checkout-chain resolvers/captures, `/store/customers` body, always-setup customer auth, best-effort captures). Partial mined candidates that lack line-items/payment still 400 at `/complete` (expected mined-fragment incompleteness, not a bug).
- [x] Confirm the regression is detected — proven **offline** by `npm run check:phase12`: a baseline-green normalized run builds a GREEN report; the same flow with `complete` flipped 200→500 builds a RED report (1 failure).
- [x] Confirm the report identifies the affected persona (`registered_customer`; the unaffected guest flow stays green — attribution is specific, not blanket).
- [x] Confirm the report identifies the affected flow (`Registered Customer Checkout`).
- [x] Confirm the report identifies the affected endpoint (`POST /store/carts/{id}/complete`, with 200→500 shown and source sessions cited).
- [x] Capture logs for documentation — live run 2026-06-21 captured the regression in Elasticsearch: `POST /store/carts/{id}/complete` status distribution `200:36  500:13  400:12` (the 500s appear only while the toggle is on; revert restores 200 and the order pool). This is the live evidence behind the offline `check:phase12` detection.

> Phase 12 is fundamentally a live demo. The two things it depends on are built
> and proven offline: (1) the **detection + attribution** logic
> (`scripts/check-phase12.mjs`, 9/9 — green↔red flip is reproducible, the
> guest flow stays green); (2) the **reversible injection** mechanism (the
> Medusa toggle, OFF unless `REGRESSION_DEMO` is set). The remaining items are
> the live capture (re-run against the stack + screenshots), which share the
> same "needs the running stack" gate as the other live validation items.

## Phase 13: Documentation

- [x] Update `README.md` with project overview. (full-pipeline rewrite: overview, mermaid architecture, prerequisites/ports, clean-checkout quickstart, the AI claim, layout, verification — supersedes the old Phase 0–3-only README)
- [x] Document system architecture. (`docs/architecture.md` — component responsibilities, stage-by-stage data contracts table, flow-signature identity, where the LLM is/isn't used, ADR index)
- [x] Document how to start Medusa. (`README.md` quickstart §1 + `docs/pipeline.md` §1 + `docs/local-development.md`)
- [x] Document how to start ELK. (`docs/pipeline.md` §2 + ports table; Kibana `behavior-logs-*` data view step)
- [x] Document how to generate traffic. (`docs/pipeline.md` §3 — `npm run traffic:generate`)
- [x] Document how to ingest logs. (`docs/pipeline.md` §5 — `npm run ingest:run`)
- [x] Document how to generate tests. (`docs/pipeline.md` §7 — `npm run script-generator:generate`)
- [x] Document how to run tests. (`docs/pipeline.md` §8 — `npm run test:all` / per-persona)
- [x] Document how to read reports. (`docs/pipeline.md` §9 — `reports/report.html`)
- [x] Document known limitations. (`docs/limitations.md`)
- [x] Document future improvements. (`docs/limitations.md` — plan §19 roadmap)

> Phase 13 deliverables: `README.md` (rewritten full-pipeline), `docs/architecture.md`,
> `docs/pipeline.md`, `docs/limitations.md`. Real wired script names are used
> (`script-generator:generate`, `test:all`), not the plan's placeholder
> `scripts:generate` / `test:run`. The existing `docs/phase-*-implementation-plan.md`
> remain as design references. Doc presence is gated by `npm run check:phase14`.

## Phase 14: Final Validation

Offline sign-off gate — `npm run check:phase14`: chains the fixture-backed phase
checks (`0/2/3/6/7/8/9/10/11/12/15`) in order, enforces the traffic-generator
`tsc --noEmit` hard gate, and confirms the Phase 13 doc deliverables exist. This
is the reproducible, stack-free portion. The live-stack probes (`check:phase1/4/5`
— Medusa/Postgres/Redis, Elasticsearch/Kibana, indexed traffic) are **excluded**
from the offline aggregate and are verified during the live clean run (below),
documented as a runbook in `docs/pipeline.md` + `docs/phase-14-implementation-plan.md`.

Clean-run procedure (live — runbook in `docs/pipeline.md`; **executed live
2026-06-21** against the Docker stack, results noted inline):

- [x] Run Medusa locally (runbook §1). (`npm run stack:core`; `/health` → 200; `check:phase1` PASS — Store + Admin live.)
- [x] Run ELK locally (runbook §2). (Elasticsearch yellow, Logstash + Filebeat shipping; Kibana started. `check:phase4`: ES + index + session/role/status filters all ✓.)
- [x] Generate synthetic traffic (runbook §3). (`MIX_PROFILE=signal-rich N=50`: Stage 1 orders=9, Stage 2a fulfilled=9, Stage 2b returns=6, linked refunds=5 ✓. Holdout/returning gates under-volume at N=50 — they need the full N=300; not a defect.)
- [~] Verify logs in Kibana (runbook §4). (ES side proven: 5181 docs, session/role/status filters return docs. Kibana data-view step is the manual UI action — Kibana container was started but the data view is created by hand.)
- [x] Run ingestion (runbook §5). (`npm run ingest:run`: 500 session flows ≥ 50; golden candidates 0 — logs bodies-off, spec-only oracle, expected.)
- [~] Run behavioral modeling (runbook §6). (Logic green via `check:phase7`; the committed 30-candidate corpus was mined from live logs. Not re-mined this session to avoid LLM-naming spend; fresh session-flows are staged for the next `behavior:mine`.)
- [x] Generate Playwright tests (runbook §7). (Committed `generated-tests/` corpus, 30 specs; `check:phase9` ≥5 valid.)
- [x] **Execute generated tests live (runbook §8) — FIRST TIME LIVE.** (`npm run test:all` against live Medusa: 30 executed, 11 passed, 4 failed, 15 skipped. The 4 failures are guest flows hitting auth-gated reads — documented gate drift, ADR 0006, not regressions. Customer suite GREEN baseline, 0 failures.)
- [x] Generate final report live (runbook §9). (`reports/report.{json,html}` + normalized run result written with persona/flow/endpoint attribution and the most-failing-endpoint callout.)
- [x] Confirm at least five behavior-based tests are generated. (`check:phase9` ≥5 valid specs; 30 in the live corpus.)
- [x] Confirm at least one regression can be detected. (Demonstrated **live**: toggle ON → `POST /store/carts/{id}/complete` returns **500** (13 such events captured in Elasticsearch; checkout broken, orderPool=0 → Stage 2 hard-exit), toggle OFF → 200 and order pool restored, customer suite GREEN. Detection+attribution by the *report* is proven offline by `check:phase12`. **Caveat:** the fault sits behind the customer-auth gate so it only fires for authenticated `/complete`; the as-generated suite has no *runnable* authenticated-checkout-completion spec — those land on the known Phase 9 `test.fixme` generation error — so the live flip is shown via traffic + ES, not via a generated spec turning red.)
- [x] Prepare final demo flow. (`docs/pipeline.md` §10 + `docs/phase-14-implementation-plan.md` "Demo flow".)

> Phase 14 acceptance checklist (plan §17): the data/AI pipeline logic is green
> offline end-to-end via `check:phase14`, **HITL review ships** (Phase 15,
> `npm run check:phase15`), and the **live clean run was executed 2026-06-21** —
> stack up, traffic → ES (5181 docs) → 500 session flows → generated suite executed
> live → green customer baseline → regression injected (500s on `/complete` captured
> in ES) → reverted to green. Two honest residuals remain: (1) the Kibana data-view
> step is a manual UI action (the ES query side is verified); (2) the live red-flip
> is shown via traffic+ES rather than a generated spec turning red, because the
> auth-gated `/complete` is only reachable by the holdout checkout, whose generated
> spec is emitted as `test.fixme` (Phase 9 payment-collection generation error).
> Closing (2) fully means fixing that generation gap so an authenticated
> checkout-completion spec is runnable — tracked as Phase 9/16 follow-up.

## Phase 15: HITL Review Dashboard

> Minimal read-only review is part of the MVP. Editing and execution gating are optional stretch goals.

Read-only review (MVP):

- [x] Add a review view to the platform dashboard listing discovered flows and generated tests. (`apps/platform-dashboard/src/review/ReviewView.tsx`, "Flow Review" tab; reads `GET /api/flows` = newest `test-candidates-*.json` joined with `generated-tests/**/*.spec.ts` by 64-hex signature.)
- [x] Group and filter the list by persona (read-only derived label from Phase 7; the reviewer never sets persona). (persona filter chips + a `has_errors`-overlay toggle; persona is display-only.)
- [x] Show per-test provenance: source `session_id`/`trace_id`, support count, golden assertions. (detail panel: full step sequence, golden assertion fields, source-session count, support/score/priority, linked `.spec.ts` path, full signature. `trace_id` is shown only when upstream supplies one — candidates carry `source_sessions`, no trace id, per the Phase 10/11 audit.)
- [x] Let the reviewer mark each generated test approved or discarded. (two actions per flow → `POST /api/decisions`.)
- [x] Persist approval/discard state in a lightweight JSON store, recording each entry's flow signature so the Phase 7 skip gate can read approval/discard decisions (ADR 0002). (`data/hitl/approvals.json` in the exact `{ entries: [{ flow_signature, status, ... }] }` shape `behavior-engine/src/coverage.ts` parses; signature-keyed upsert, no duplicates; missing/malformed store → empty manifest, never fatal.)

> Implemented as a Vite dev-server endpoint (no separate process): the SPA reads
> `GET /api/flows` and writes `POST /api/decisions`, both served by
> `apps/platform-dashboard/server/vite-plugin-hitl.ts` over the pure read/merge/
> write logic in `server/hitl-store.ts`. Run with `npm run dashboard:dev` → "Flow
> Review" tab (`http://localhost:5173`). `npm run check:phase15` proves it
> **offline** (7/7): the review files + endpoint wiring exist, and a tsx round-trip
> drives the REAL store logic and the REAL `coverage.ts` skip-gate reader against
> the shared repo-root store — graceful absence, persisted `{entries}` shape,
> in-place re-decide (no duplicate), approved+discarded both feeding the skip gate,
> malformed-store tolerance, and the `loadFlows()` join. Live endpoint round-trip
> verified against the 30-candidate corpus (30 flows joined to specs; approve→discard
> updates in place). Note: `tsc -b` emit was redirected to `.tsbuild-node/` and the
> stale tracked `vite.config.js`/`.d.ts` removed so Vite loads `vite.config.ts`
> (and the live plugin) directly. Stretch goals (step/assertion editing, execution
> gating) remain deferred per the plan.

Optional (time-permitting):

- [ ] Edit flow steps or assertions in the UI (persona re-derives from edited steps).
- [ ] Gate which tests the runner executes based on approval state.

## Phase 16: Agentic Orchestration & Judgment Layer

> Post-MVP enhancement (ADR 0005). Agents **propose** (rank/plan/triage/advise/deep-mine logs); deterministic code **disposes** (verify/detect/gate). Strictly log-scoped and non-blocking — `AGENT_LAYER=off` is a no-op for correctness. No live-app exploration, no invented flows, no agent on the oracle/gate path.

- [ ] Deterministic pipeline DAG (`dag.ts`) + read-only agent tools (`tools.ts`) over `flowSignature`, `checkOasDrift`, support counts, `tsc`/`--list`, Phase 11 results.
- [ ] Orchestrator (planner, not plumber): decides budget/refresh-vs-hold/ordering at decision points only; static DAG is the fallback. Never auto-refreshes goldens (ADR 0001).
- [ ] Flow-Ranker: risk/value ordering of mined flows → **frozen** Phase 9 selection input; fallback = support-count.
- [ ] Flow-Verifier (advisory): coherence note; signature round-trip stays authoritative.
- [ ] Code-Verifier (advisory, **NOT a gate**): semantic smells; `tsc` + round-trip + execution remain the gate.
- [ ] Drift-Triage: interpret `checkOasDrift` → refresh/hold recommendation; never decides staleness itself.
- [ ] Log-Pattern-Miner (optional, in-scope): surface latent **observed** workflows; hard observed-transition guard rejects unobserved steps/transitions; recombined candidates labeled `synthetic_source` + spec-only goldens + kept out of the observed baseline; never fabricates a flow no session performed.
- [ ] Per-agent deterministic fallback (mirrors `naming.ts`); pipeline completes with the LLM unreachable.
- [ ] Meta-eval harness + `scripts/check-phase16.mjs`; root scripts `agent:run`, `check:phase16`.
- [ ] Acceptance: non-blocking (`AGENT_LAYER=off` reproduces baseline), fence held (no agent writes goldens/verdicts), Log-Pattern-Miner boundary tests pass.

## MVP Completion Checklist

- [x] Medusa runs locally.
- [x] Store API works.
- [x] Admin API works.
- [x] Simple storefront works.
- [x] Platform dashboard works.
- [x] Structured logs are produced.
- [x] Logs are stored in Elasticsearch.
- [x] Logs are visible in Kibana.
- [x] Guest, customer, and admin personas are simulated.
- [ ] Logs are grouped by session.
- [ ] Behavioral flows are discovered.
- [ ] Playwright API tests are generated.
- [ ] Generated tests are executable.
- [ ] Golden response comparison works.
- [x] Regression report is generated. (`report.json` + self-contained `report.html`, persona/flow/endpoint rollups; `npm run check:phase11`. Live capture pending the running stack.)
- [x] HITL review: discovered flows and generated tests are reviewable in the dashboard with approve/discard. (Phase 15 — "Flow Review" tab; signature-keyed decisions persist to `data/hitl/approvals.json` and feed the Phase 7 skip gate; `npm run check:phase15`, 7/7.)
