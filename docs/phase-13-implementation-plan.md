# Phase 13 — Documentation

## Goal

Make the project reproducible and explainable by someone who has never seen it: a top-level `README.md` that walks the full pipeline end to end, plus architecture and per-stage operating instructions. The thesis/demo credibility depends on this being runnable from a clean checkout.

## Deliverables

```
README.md                # project overview + quickstart + full pipeline
docs/
  architecture.md        # system diagram + data flow + component responsibilities
  pipeline.md            # step-by-step run order with commands
  limitations.md         # known limitations + future improvements
  (existing phase-*-implementation-plan.md remain as design references)
```

## README.md contents

1. **Overview.** One paragraph: what the platform does (AI-driven behavioral regression testing over Medusa via ELK), and the core claim (emergent persona discovery + golden-schema regression detection).
2. **Architecture diagram.** Reuse/refresh the mermaid flowchart from plan §5 and the ERD under `docs/`.
3. **Prerequisites.** Node version, package manager, Docker/Compose, `ANTHROPIC_API_KEY`, ports table (Medusa 9000, ES 9200, Kibana 5601, storefront 8000, dashboard 5173).
4. **Quickstart (happy path), in order:**
   - Start Medusa + Postgres + Redis — `npm run compose:up`
   - Start ELK — `npm run elk:up`
   - Create the Kibana `behavior-logs-*` data view (one-time)
   - Generate traffic — `npm run traffic:generate`
   - Ingest logs — `npm run ingest:run`
   - Run behavioral modeling — `npm run behavior:mine`
   - Generate tests — `npm run scripts:generate` *(Phase 9 — script-generator service, not yet wired; follows the `service:verb` convention)*
   - Execute tests — `npm run test:run` *(Phase 11 — test-runner service, not yet wired)*
   - Read the report — open `reports/report.html`
5. **The AI claim, briefly.** Point readers to the Phase 7 validation report (emergent classification accuracy + holdout support count + negative control) so the "AI-driven" claim is backed by numbers, not assertion.

## docs/architecture.md

- Component responsibilities (one line each): Medusa, logging middleware, ELK, traffic generator, ingestion, behavior engine, golden library, script generator, test runner, reporting.
- Data contracts between stages (log doc → session-flow → candidate → spec → run result → report), each linking to the relevant phase plan.
- Where the LLM is and isn't used (Haiku 4.5 for traffic, Sonnet 4.6 — `BEHAVIOR_LLM_MODEL`-configurable to Opus 4.8 — for naming/anomaly/assertions; **never** for classification).

## docs/limitations.md

- Synthetic data is not real production traffic (mitigated by mixed sources + holdout, plan §8).
- Mining is classical (n-gram/PrefixSpan), not deep ML.
- Golden schema snapshots are shape/type level, not value level.
- Single-node ELK; memory-bound on a laptop.
- Future improvements (plan §19): embeddings clustering, anomaly detection, CI/CD integration, OpenTelemetry traces, Playwright UI tests.

## Validation / acceptance

- A reader can go clean checkout → green report following only the README.
- Every pipeline stage has a documented command.
- Architecture and data-flow are documented and cross-linked to phase plans.
- Known limitations and future work are stated honestly.
