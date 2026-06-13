# Phase 5 — Synthetic Traffic Generator

## Goal

Produce a realistic, intentionally messy stream of Medusa API traffic that lands in Elasticsearch as structured logs, so downstream phases have something genuine to mine. The generator must avoid the "circularity trap" (plan §8): if it emits only clean scripted flows, the behavior engine just rediscovers what we hardcoded. We mix scripted, LLM-varied, and noise traffic, and we keep the registered-customer checkout as a **holdout** that exists only in LLM-varied sessions.

## Critical constraint: no persona header

The generator attaches `session_id` and `trace_id` headers only. It does **not** send a persona or role header. Role is established naturally by which auth endpoints a session hits (the JWT `actor_type` the Medusa logging middleware already records). Persona is derived later, at Phase 7, from flow content. If the generator labeled sessions, the Phase 7 "emergent discovery" claim collapses. See `persona-classification` memory and plan §10.3.

## Recommended: body capture ON in dev (enrichment, not required — ADR 0001)

Run Medusa with `LOG_CAPTURE_BODIES=true` for the MVP. The golden **oracle is the OpenAPI spec** (Phase 8 / ADR 0001), so the pipeline works with bodies off — but bodies enrich it: they give generated tests realistic **sample payloads** (`request_payload`, reused in Phase 9) and **tighten** under-specified spec schemas against real responses. This is safe because traffic runs against synthetic data with a mock payment provider (no real PII/PCI). See Phase 2 §4 (masking + §7.1 reduction still apply when capture is on).

## Location

```
services/traffic-generator/
  src/
    client.ts            # HTTP client wrapper, header injection, retry hooks
    config.ts            # env loading, base URL, publishable key, admin creds
    ids.ts               # session_id / trace_id generators
    flows/
      guest.ts           # scripted guest backbone
      admin.ts           # scripted admin backbone
      edge.ts            # edge-case flows
    llm/
      narrative.ts       # Claude call -> session narrative
      translate.ts       # narrative -> concrete API call sequence
    noise.ts             # abandonment, retries, contamination, shuffling
    personas/
      customer-llm.ts    # registered-customer flow, LLM-varied ONLY (holdout)
    run.ts               # orchestrator: builds the session mix, executes
  package.json
  .env.example
```

## Session mix (target ~100–150 sessions)

| Source | Share | Min sessions | Personas covered |
| --- | --- | --- | --- |
| Scripted | ~70% | 35 guest + 20 admin | guest, admin |
| LLM-varied | ~20% | 20 | all, **incl. holdout customer checkout** |
| Noise-injected | ~10% | 10 | overlay on scripted |
| Edge-case | (within noise/scripted budget) | 20 | edge overlay |

## Implementation steps

1. **Client + config.** Wrap `fetch`/`axios`. Inject `x-session-id`, `x-trace-id`, and `x-publishable-api-key` (store APIs) on every request. Centralize base URL and admin login. Surface 4xx/5xx without throwing so noise logic can react.
2. **ID helpers.** `session_id` = `sess-<source>-<uuid>` (source tag is for *our* debugging only, never sent as a classifier signal — Phase 7 must not parse it). `trace_id` = uuid per request.
3. **Scripted guest flow** (plan §8.5 backbone): regions → products → product detail → create cart → add line item → (shipping option → payment session →) complete → view order.
4. **Scripted admin flow:** `POST /auth/user/emailpass` → list/create/update products → list orders → list customers.
5. **Edge-case flow:** admin call without token (401), `POST /store/carts/{invalid}/line-items` (404), complete with invalid payload (400/422), `GET /store/products/{invalid}` (404).
6. **LLM-varied traffic** (Haiku 4.5, `claude-haiku-4-5-20251001`):
   - `narrative.ts` prompts Claude with the available endpoint list and asks for a plausible 5–15 call session (vary order, skip steps, abandon, retry, browse-without-buy). Prompt template in plan §8.2.
   - `translate.ts` maps each narrative line to a concrete client call, resolving IDs at runtime.
   - `customer-llm.ts` realizes the **full registered-customer checkout** (register → login → browse → cart → line-items → complete). This sequence must appear **only here**, never in `flows/`.
7. **Noise injection** (plan §8.3):
   - Abandonment: cut 40% of scripted sessions at a random pre-completion step.
   - Retry: after a 4xx, repeat the call with corrected or still-wrong input.
   - Contamination: occasionally fire one out-of-persona endpoint inside a session.
   - Shuffling: randomize product list/detail ordering.
8. **Orchestrator (`run.ts`).** Build the weighted mix, run sessions (bounded concurrency, e.g. 5), log a summary table of counts per source.

## Model / cost

- Bulk narratives: **Haiku 4.5** — low cost/latency, ~20–40 calls per run.
- No Opus here; Opus is reserved for Phase 7 naming/anomaly calls.
- Add `ANTHROPIC_API_KEY`, `TRAFFIC_LLM_MODEL=claude-haiku-4-5-20251001` to `.env.example`.

## Data contract produced (in logs → ES)

Each request yields one `behavior-logs-*` document with: `timestamp`, `trace_id`, `session_id`, `user_role` (`customer` / `admin` / `null` for guests, derived from the JWT by the middleware — **not** from us), `user_id`, `method`, `endpoint`, `normalized_endpoint`, `request_payload` (reduced), `response_code`, `response_body` (reduced, plan §7.1), `duration_ms`, `source: "medusa"`.

## Validation / acceptance

- `npm run traffic:generate` runs end to end without crashing.
- Generated traffic appears in Medusa logs and then in `behavior-logs-*` (re-run `check:phase4`).
- The session-source mix is reflected in distinct `session_id` values and the spread of `user_role` and `response_code` in logs.
- **Holdout check:** at least 5 completed registered-customer checkouts exist in logs (role transitions null→customer ending in `POST /store/carts/{id}/complete`), with **no** corresponding scripted flow in `flows/`.
- Edge sessions produce a healthy share of 4xx/5xx for Phase 7 error-flow mining.

## Risks

- **Holdout starvation:** if LLM sessions rarely complete checkout, the flow won't clear PrefixSpan support. Mitigate by forcing ≥5 completed customer checkouts in `customer-llm.ts`.
- **Source-tag leakage:** keep the `<source>` tag in `session_id` out of any field Phase 7 reads as a signal; it is for human debugging only.
- **Seed-data coupling:** resolve product/variant/region IDs at runtime, never hardcode.
