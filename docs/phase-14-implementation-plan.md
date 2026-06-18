# Phase 14 — Final Validation

## Goal

Run the entire pipeline from a clean state and confirm every acceptance criterion in plan §17 is met. This is the dress rehearsal for the demo and the sign-off gate for the MVP.

## Clean-run procedure

Execute in order, from a fresh environment (volumes reset), capturing output at each step:

1. **Medusa from clean** — reset volumes, `npm run compose:up` with `LOG_CAPTURE_BODIES=true` (enrichment for the MVP; the golden oracle is the OAS and works bodies-off — ADR 0001), confirm seed + admin user + publishable key, verify `GET /store/products` and admin auth.
2. **ELK from clean** — `npm run elk:up`, create the `behavior-logs-*` data view, confirm green/yellow cluster.
3. **Generate traffic** — `npm run traffic:generate`; confirm the source mix and ≥5 completed customer checkouts (holdout).
4. **Verify in Kibana** — filter by `session_id`, `user_role`, `status` (and `event`/`service`); confirm spread.
5. **Ingest** — `npm run ingest:run`; confirm ≥50 session-flow records and golden candidates.
6. **Behavioral modeling** — `npm run behavior:mine`; confirm candidates + the classification/holdout/control validation report.
7. **Generate tests** — `npm run scripts:generate` *(Phase 9, to be wired)*; confirm ≥5 valid `.spec.ts`.
8. **Execute** — `npm run test:run` *(Phase 11, to be wired)*; confirm green baseline.
9. **Report** — open `reports/report.html`.
10. **Regression demo** — run Phase 12 scenario; confirm red report with correct attribution; revert to green.
11. **HITL review** — open the platform dashboard review view; confirm discovered flows and generated tests are listed, filterable by persona (read-only derived label), show provenance, and can be marked approved/discarded with the decision persisted.

## Acceptance checklist (plan §17 + MVP completion)

- [ ] Medusa runs locally; Store + Admin APIs testable.
- [ ] Storefront and platform dashboard available.
- [ ] Guest, customer, and admin personas simulated.
- [ ] Logs include `trace_id`, `session_id`, `user_role`, `endpoint`, and `status` (request/response bodies only when `LOG_CAPTURE_BODIES=true`; no persona field — emergent, plan §10.3).
- [ ] Logs stored in Elasticsearch and visible in Kibana; groupable by session.
- [ ] ≥5 behavioral flows discovered.
- [ ] **Persona derived as an emergent attribute and validated against JWT `user_role` with reported precision/recall.**
- [ ] **Registered-customer checkout discovered as holdout, with a reported support count.**
- [ ] **Negative control passes (no un-injected flow falsely discovered).**
- [ ] ≥5 Playwright API tests generated and executable.
- [ ] Golden response comparison works (dynamic fields ignored; real schema changes caught).
- [ ] JSON + HTML regression report produced.
- [ ] At least one regression detected with persona/flow/endpoint attribution.
- [ ] **HITL review (read-only, MVP): discovered flows and generated tests are reviewable in the dashboard, filterable by persona, with approve/discard persisted.**

## Demo flow (final deliverable)

A single narrated run: traffic → Kibana logs → discovered flows (show the emergent classification report and the holdout support count) → generated tests → green report → inject regression → red report with attribution → revert. Keep the Phase 7 validation numbers on screen — they are the evidence behind the "AI-driven" title.

## Exit criteria

All acceptance boxes checked, the clean run reproduces end to end, and the regression demo flips red→green on a single reversible toggle.
