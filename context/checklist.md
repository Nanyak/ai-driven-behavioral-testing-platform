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
- [x] Read `persona` from a custom header.
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

- [ ] Create `apps/storefront`.
- [ ] Configure Storefront Medusa base URL.
- [ ] Configure Storefront publishable API key.
- [ ] Display seeded products from `GET /store/products`.
- [ ] Display a product detail view.
- [ ] Create a cart from the storefront.
- [ ] Add a selected variant to the cart.
- [ ] Show basic cart item count and cart contents.
- [ ] Create `apps/platform-dashboard`.
- [ ] Show Medusa backend health/status.
- [ ] Show Store API availability.
- [ ] Show Admin API authentication availability.
- [ ] Link to Medusa Admin at `http://localhost:9000/app`.
- [ ] Link to the storefront.
- [ ] Add dashboard placeholders for logs, traffic generation, behavior flows, generated tests, and reports.
- [ ] Document expected frontend ports.
- [ ] Verify both frontend apps can start locally.

## Phase 4: ELK Integration

- [ ] Create `infra/docker-compose.yml`.
- [ ] Add Elasticsearch service.
- [ ] Add Kibana service.
- [ ] Add Logstash or Filebeat service.
- [ ] Configure Elasticsearch as a single-node local instance.
- [ ] Configure memory limits for local development.
- [ ] Configure Logstash/Filebeat to ingest Medusa JSON logs.
- [ ] Create an index pattern such as `behavior-logs-*`.
- [ ] Verify logs are indexed in Elasticsearch.
- [ ] Verify logs are visible and searchable in Kibana.
- [ ] Test filtering logs by `session_id`.
- [ ] Test filtering logs by `persona`.
- [ ] Test filtering logs by `response_code`.

## Phase 5: Synthetic Traffic Generator

- [ ] Create `services/traffic-generator`.
- [ ] Add shared HTTP client configuration.
- [ ] Add Medusa base URL configuration.
- [ ] Add publishable API key configuration.
- [ ] Add admin credentials configuration.
- [ ] Implement helper for generating `session_id`.
- [ ] Implement helper for generating `trace_id`.
- [ ] Implement helper for attaching persona headers.
- [ ] Implement Guest Shopper flow.
- [ ] Implement Registered Customer flow.
- [ ] Implement Admin Operator flow.
- [ ] Implement Edge Case User flow.
- [ ] Generate at least 20 guest sessions.
- [ ] Generate at least 20 customer sessions.
- [ ] Generate at least 20 admin sessions.
- [ ] Generate at least 20 edge-case sessions.
- [ ] Confirm generated traffic appears in Medusa logs.
- [ ] Confirm generated traffic appears in Elasticsearch.

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
- [ ] Extract candidate golden responses.
- [ ] Store golden responses under `golden-responses/`.
- [ ] Add a command to run ingestion from the terminal.
- [ ] Verify at least 50 sessions can be processed.

## Phase 7: Behavioral Modeling Engine

- [ ] Create `services/behavior-engine`.
- [ ] Load session flows from ingestion output.
- [ ] Implement persona classification rules.
- [ ] Identify Guest Shopper flows.
- [ ] Identify Registered Customer flows.
- [ ] Identify Admin Operator flows.
- [ ] Identify Edge Case User flows.
- [ ] Count endpoint sequence frequency.
- [ ] Implement simple n-gram sequence mining.
- [ ] Implement PrefixSpan frequent sequential pattern mining.
- [ ] Configure minimum support threshold for PrefixSpan.
- [ ] Prune duplicate or subsumed flows.
- [ ] Compare n-gram output against PrefixSpan output.
- [ ] Identify the top frequent flows.
- [ ] Identify important error flows based on `4xx` and `5xx` responses.
- [ ] Rank candidates by support, persona, business importance, and error coverage.
- [ ] Produce test candidate JSON.
- [ ] Verify at least five test candidates are generated from mined behavior flows.

## Phase 8: Golden Response Handling

- [ ] Define a golden response format.
- [ ] Define ignored dynamic fields.
- [ ] Normalize response bodies before comparison.
- [ ] Convert full response bodies into schema snapshots where needed.
- [ ] Add schema comparison utility.
- [ ] Add golden response comparison utility.
- [ ] Test comparison with a matching response.
- [ ] Test comparison with a changed response code.
- [ ] Test comparison with a changed response schema.
- [ ] Confirm dynamic fields do not cause false failures.

## Phase 9: Script Generator

- [ ] Create `services/script-generator`.
- [ ] Read test candidates from the behavior engine.
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

## MVP Completion Checklist

- [x] Medusa runs locally.
- [x] Store API works.
- [x] Admin API works.
- [ ] Simple storefront works.
- [ ] Platform dashboard works.
- [x] Structured logs are produced.
- [ ] Logs are stored in Elasticsearch.
- [ ] Logs are visible in Kibana.
- [ ] Guest, customer, and admin personas are simulated.
- [ ] Logs are grouped by session.
- [ ] Behavioral flows are discovered.
- [ ] Playwright API tests are generated.
- [ ] Generated tests are executable.
- [ ] Golden response comparison works.
- [ ] Regression report is generated.
