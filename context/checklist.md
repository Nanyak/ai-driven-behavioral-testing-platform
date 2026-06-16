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
- [ ] **VERIFY against live Medusa 2.15.5:** `POST /store/returns`, admin return-receive + refund, fulfillment, and `POST /admin/promotions` body shapes (currently best-effort, degrade to logged 4xx).
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

- [ ] Create `services/behavior-engine`.
- [ ] Load session flows from ingestion output.
- [ ] Mine flows from the raw, unlabeled sequence stream (do not pre-label sessions by persona).
- [ ] Derive deterministic flow attributes from step content: `requires_auth` (contains `/auth/customer/*` or `/store/customers`, **or** a successful 2xx cart/checkout mutation on `/store/carts`/`/store/payment-collections` — carts are auth-gated, ADR 0003), `is_admin` (contains `/admin/*`), `has_errors` (contains 4xx/5xx).
- [ ] Resolve persona from attributes: `is_admin` → admin_operator; `requires_auth` and not admin → registered_customer; neither → guest_shopper; `has_errors` as an orthogonal edge-case overlay.
- [ ] Resolve mid-session role changes by highest-privilege attribute reached (admin > customer > guest).
- [ ] Keep JWT `user_role` only as held-out ground truth for validation, never as classifier input.
- [ ] Add `persona_source: "emergent_attributes"` field to flow output.
- [ ] Identify Guest Shopper flows.
- [ ] Identify Registered Customer flows.
- [ ] Identify Admin Operator flows.
- [ ] Identify Edge Case User flows.
- [ ] Count endpoint sequence frequency.
- [ ] Implement simple n-gram sequence mining.
- [ ] Implement PrefixSpan frequent sequential pattern mining.
- [ ] Configure minimum support threshold for PrefixSpan.
- [ ] Prune duplicate or subsumed flows.
- [ ] Implement a single canonical flow-signature function (`signature.ts`): stable hash of the normalized `METHOD endpoint` step sequence, persona-independent (ADR 0002); reuse it in dedup, the skip gate, and Phase 9 emit.
- [ ] Deduplicate flows with identical normalized step sequences (keep highest-support).
- [ ] Cluster flows sharing a common prefix of three or more steps (keep longest representative).
- [ ] Cap output at ten canonical flows per persona.
- [ ] Implement the cross-run coverage manifest (`coverage.ts`): collect already-covered signatures from `generated-tests/**/*.spec.ts` and the HITL approval store (approved + discarded).
- [ ] Apply the cross-run skip gate after ranking and before LLM naming: drop ranked flows whose signature is already covered (ADR 0002).
- [ ] Report `skipped_existing` count in the run summary.
- [ ] Compare n-gram output against PrefixSpan output.
- [ ] Identify the top frequent flows.
- [ ] Identify important error flows based on `4xx` and `5xx` responses.
- [ ] Rank candidates by support, persona, business importance, and error coverage.
- [ ] Produce test candidate JSON.
- [ ] Verify at least five test candidates are generated from mined behavior flows.
- [ ] Verify the Registered Customer checkout flow is discovered despite not being present in scripted sessions (holdout validation).
- [ ] Score emergent persona classification against JWT `user_role` ground truth (report precision/recall per persona).
- [ ] Report holdout recovery as a support count (Registered Customer checkout sequence support ≥ threshold), not a binary.
- [ ] Add a negative control: confirm no un-injected flow is reported as high-support.
- [ ] Use the LLM (Opus 4.8) for flow naming, anomaly/contamination detection, and assertion recommendation (not for classification).

## Phase 8: Golden Response Handling

- [ ] Define the golden response JSON format (endpoint, expected_status, expected_schema, ignore_fields, schema_source, oas_operation_id, oas_ref, oas_version, captured_at, source_sessions).
- [ ] Define the global ignore-fields list (id, created_at, updated_at, deleted_at, metadata, token, cart_id, order_id, trace_id, session_id).
- [ ] Load the OpenAPI spec and resolve `$ref` into typed per-(operation, status) schemas — the authoritative oracle (ADR 0001).
- [ ] Source `expected_status` from the spec for happy-path steps; use the observed status for edge/error steps.
- [ ] Implement schema extraction: walk observed response JSON tree and classify leaf types (observed half of the intersection).
- [ ] Intersect the OAS skeleton with observed schemas to tighten under-specified fields; stamp `schema_source` (`openapi` / `openapi+observed` / `observed`).
- [ ] Stamp OAS provenance on spec-sourced goldens (`oas_operation_id`, `oas_ref`, `oas_version`) for traceability and drift detection.
- [ ] Confirm a valid spec-only golden is produced with bodies off (oracle works without logged bodies).
- [ ] Implement merge logic for optional fields across multiple sessions of the same endpoint.
- [ ] Normalize response bodies before comparison (strip ignored fields).
- [ ] Add schema comparison utility.
- [ ] Add golden response comparison utility.
- [ ] Implement versioning: store golden responses with a `captured_at` timestamp; require explicit refresh to update baseline.
- [ ] Test comparison with a matching response.
- [ ] Test comparison with a changed response code.
- [ ] Test comparison with a changed response schema (new field added, field removed, type changed).
- [ ] Confirm dynamic fields do not cause false failures.
- [ ] Confirm an intentional schema change is detected as a regression.

## Phase 9: Script Generator

- [ ] Create `services/script-generator`.
- [ ] Read test candidates from the behavior engine.
- [ ] Deduplicate candidates: remove identical step sequences, keep highest-support representative.
- [ ] Cluster candidates by common prefix (three or more steps); keep longest representative per cluster.
- [ ] Cap at ten canonical tests per persona.
- [ ] Generate Playwright `.spec.ts` files.
- [ ] Generate one test per selected behavior flow.
- [ ] Add Playwright project configuration.
- [ ] Add base URL configuration.
- [ ] Add publishable API key handling.
- [ ] Add admin authentication handling.
- [ ] Resolve product IDs at runtime.
- [ ] Resolve variant IDs at runtime.
- [ ] Resolve cart IDs at runtime.
- [ ] Resolve customer/admin tokens at runtime.
- [ ] Add status code assertions.
- [ ] Add schema or golden response assertions.
- [ ] Derive each test filename from the canonical flow signature (`<persona>/<short-hash>.spec.ts`) so regeneration is idempotent (ADR 0002).
- [ ] Stamp the flow signature into each generated test (annotation / header comment) so the corpus is self-describing for the Phase 7 skip gate.
- [ ] Reuse the Phase 7 `signature.ts` in the defensive dedup re-pass (no second "same flow?" key).
- [ ] Write generated tests to `generated-tests/`.
- [ ] Verify generated tests are syntactically valid.

## Phase 10: Test Execution

- [ ] Create `services/test-runner`.
- [ ] Add command for running generated Playwright tests.
- [ ] Add command for running only guest tests.
- [ ] Add command for running only customer tests.
- [ ] Add command for running only admin tests.
- [ ] Add command for running only edge-case tests.
- [ ] Capture Playwright JSON output.
- [ ] Capture Playwright HTML report.
- [ ] Confirm generated tests run against Medusa.
- [ ] Confirm failed assertions are reported clearly.

## Phase 11: Reporting

- [ ] Create `reports/` output directory.
- [ ] Define report JSON schema.
- [ ] Include total tests executed.
- [ ] Include passed and failed test counts.
- [ ] Include persona-level results.
- [ ] Include flow-level results.
- [ ] Include endpoint-level failures.
- [ ] Include expected vs actual status code.
- [ ] Include golden response diff.
- [ ] Include source `session_id`.
- [ ] Include source `trace_id`.
- [ ] Generate `reports/report.json`.
- [ ] Generate `reports/report.html`.
- [ ] Verify the report can be opened locally.

## Phase 12: Regression Demonstration

- [ ] Create a controlled regression scenario.
- [ ] Change one response code or response schema in Medusa.
- [ ] Re-run generated tests.
- [ ] Confirm the regression is detected.
- [ ] Confirm the report identifies the affected persona.
- [ ] Confirm the report identifies the affected flow.
- [ ] Confirm the report identifies the affected endpoint.
- [ ] Capture screenshots or logs for documentation.

## Phase 13: Documentation

- [ ] Update `README.md` with project overview.
- [ ] Document system architecture.
- [ ] Document how to start Medusa.
- [ ] Document how to start ELK.
- [ ] Document how to generate traffic.
- [ ] Document how to ingest logs.
- [ ] Document how to generate tests.
- [ ] Document how to run tests.
- [ ] Document how to read reports.
- [ ] Document known limitations.
- [ ] Document future improvements.

## Phase 14: Final Validation

- [ ] Run Medusa locally from a clean setup.
- [ ] Run ELK locally from a clean setup.
- [ ] Generate synthetic traffic.
- [ ] Verify logs in Kibana.
- [ ] Run ingestion.
- [ ] Run behavioral modeling.
- [ ] Generate Playwright tests.
- [ ] Execute generated tests.
- [ ] Generate final report.
- [ ] Confirm at least five behavior-based tests are generated.
- [ ] Confirm at least one regression can be detected.
- [ ] Prepare final demo flow.

## Phase 15: HITL Review Dashboard

> Minimal read-only review is part of the MVP. Editing and execution gating are optional stretch goals.

Read-only review (MVP):

- [ ] Add a review view to the platform dashboard listing discovered flows and generated tests.
- [ ] Group and filter the list by persona (read-only derived label from Phase 7; the reviewer never sets persona).
- [ ] Show per-test provenance: source `session_id`/`trace_id`, support count, golden assertions.
- [ ] Let the reviewer mark each generated test approved or discarded.
- [ ] Persist approval/discard state in a lightweight JSON store, recording each entry's flow signature so the Phase 7 skip gate can read approval/discard decisions (ADR 0002).

Optional (time-permitting):

- [ ] Edit flow steps or assertions in the UI (persona re-derives from edited steps).
- [ ] Gate which tests the runner executes based on approval state.

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
- [ ] Regression report is generated.
- [ ] HITL review: discovered flows and generated tests are reviewable in the dashboard with approve/discard.
