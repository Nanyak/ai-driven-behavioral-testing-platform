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
- [x] Test filtering logs by `response_code`.

## Phase 5: Synthetic Traffic Generator

- [ ] Create `services/traffic-generator`.
- [ ] Add shared HTTP client configuration.
- [ ] Add Medusa base URL configuration.
- [ ] Add publishable API key configuration.
- [ ] Add admin credentials configuration.
- [ ] Implement helper for generating `session_id`.
- [ ] Implement helper for generating `trace_id`.
- [ ] Attach `session_id` and `trace_id` headers to all outgoing requests (no persona header).

Scripted flows (~70% of sessions):

- [ ] Implement Guest Shopper scripted flow.
- [ ] Implement Admin Operator scripted flow.
- [ ] Generate at least 35 guest sessions (scripted).
- [ ] Generate at least 20 admin sessions (scripted).

LLM-varied flows (~20% of sessions — holdout):

- [ ] Implement LLM prompt to generate realistic session narratives using the Claude API (Haiku 4.5, `claude-haiku-4-5-20251001`, for bulk generation).
- [ ] Translate LLM-generated narratives into API call sequences.
- [ ] Implement Registered Customer flow from LLM-varied output only (no scripted equivalent).
- [ ] Generate at least 20 LLM-varied sessions across all personas.
- [ ] Confirm the Registered Customer full checkout sequence is present only in LLM-varied sessions.
- [ ] Ensure at least 5 completed Registered Customer checkouts appear in logs so the holdout flow clears the PrefixSpan support threshold.

Noise injection (~10% of sessions):

- [ ] Implement abandoned flow: cut sessions short at a random step for 40% of scripted sessions.
- [ ] Implement retry noise: repeat a failing call with corrected or incorrect input after a 4xx response.
- [ ] Implement persona contamination: occasionally include out-of-persona endpoint calls within a session.
- [ ] Implement random step shuffling for browsing sequences (product list / product detail ordering).
- [ ] Generate at least 10 noise-injected sessions.

Edge-case flow (injected):

- [ ] Implement Edge Case User flow (unauthenticated admin call, invalid cart ID, invalid payload).
- [ ] Generate at least 20 edge-case sessions.

Validation:

- [ ] Confirm generated traffic appears in Medusa logs.
- [ ] Confirm generated traffic appears in Elasticsearch.
- [ ] Confirm session mix (scripted / LLM-varied / noise) is reflected in the spread of log `user_role` and `session_id` fields (no persona field is logged).
- [ ] Validate that at least one Registered Customer checkout sequence is present in logs without a corresponding scripted flow.

## Phase 6: Data Ingestion Service

- [ ] Create `services/log-ingestion`.
- [ ] Add Elasticsearch client configuration.
- [ ] Query logs by time range.
- [ ] Query logs by `source = medusa`.
- [ ] Group logs by `session_id`.
- [ ] Sort grouped logs by timestamp.
- [ ] Normalize dynamic URL segments.
- [ ] Remove noisy or irrelevant endpoints.
- [ ] Convert logs into behavioral sequence records.
- [ ] Store extracted session flows as JSON.
- [ ] Extract candidate golden responses using the schema-extraction algorithm defined in Phase 8 (plan §11.1).
- [ ] Store golden responses under `golden-responses/`.
- [ ] Add a command to run ingestion from the terminal.
- [ ] Verify at least 50 sessions can be processed.

## Phase 7: Behavioral Modeling Engine

- [ ] Create `services/behavior-engine`.
- [ ] Load session flows from ingestion output.
- [ ] Mine flows from the raw, unlabeled sequence stream (do not pre-label sessions by persona).
- [ ] Derive deterministic flow attributes from endpoint content: `requires_auth` (contains `/auth/customer/*` or `/store/customers`), `is_admin` (contains `/admin/*`), `has_errors` (contains 4xx/5xx).
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
- [ ] Deduplicate flows with identical normalized step sequences (keep highest-support).
- [ ] Cluster flows sharing a common prefix of three or more steps (keep longest representative).
- [ ] Cap output at ten canonical flows per persona.
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
- [ ] Persist approval/discard state in a lightweight JSON store.

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
- [ ] Guest, customer, and admin personas are simulated.
- [ ] Logs are grouped by session.
- [ ] Behavioral flows are discovered.
- [ ] Playwright API tests are generated.
- [ ] Generated tests are executable.
- [ ] Golden response comparison works.
- [ ] Regression report is generated.
- [ ] HITL review: discovered flows and generated tests are reviewable in the dashboard with approve/discard.
