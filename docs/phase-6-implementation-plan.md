# Phase 6 — Data Ingestion Service

## Goal

Read raw request logs from Elasticsearch and turn them into clean, session-grouped behavioral sequences plus candidate golden responses. This is the bridge between "logs exist" and "we can mine behavior." Output must be unlabeled by persona — grouping and normalization only — so Phase 7 can perform genuine emergent classification.

## Location

```
services/log-ingestion/
  src/
    es-client.ts         # Elasticsearch query client
    query.ts             # time-range + source filter, scroll/search_after
    group.ts             # group by session_id, sort by timestamp
    normalize.ts         # dynamic-segment normalization
    denoise.ts           # drop irrelevant endpoints (health, assets)
    sessions.ts          # build session-flow records
    golden.ts            # candidate golden-response extraction (calls Phase 8 schema logic)
    run.ts               # CLI entrypoint
  package.json
data/
  sessions/              # one JSON per run: session-flows-<runId>.json
golden-responses/        # candidate goldens (refined in Phase 8)
```

## Implementation steps

1. **ES client + query.** Connect to `http://localhost:9200`. Query `behavior-logs-*` by time range (`--from`, `--to`, default last 24h) and `source = medusa`. Use `search_after`/scroll for >10k docs. Pull only needed fields.
2. **Group + sort.** Bucket documents by `session_id`; sort each bucket by `timestamp` ascending. Discard sessions with a single step (no sequence to mine) unless they are error-only edge cases worth keeping.
3. **Normalize endpoints.** Replace dynamic segments with placeholders so sequences align across sessions:
   - `/store/carts/cart_01H...` → `/store/carts/{id}`
   - `/store/products/prod_...` → `/store/products/{id}`
   - `/store/carts/{id}/line-items/li_...` → `/store/carts/{id}/line-items/{lineItemId}`
   - `/admin/products/prod_...` → `/admin/products/{id}`
   - Prefer the `normalized_endpoint` already produced by the Phase 2 middleware; this step is a safety re-normalization for anything missed.
4. **Denoise.** Drop endpoints irrelevant to behavior (health checks, static assets, favicon, publishable-key probes) via an explicit allow/deny list. Keep the list in one place so it is auditable.
5. **Build session-flow records.** Emit the contract below. Keep `role_observed` (the raw JWT roles seen) **only** for Phase 7 validation — it must be clearly marked as ground-truth-not-input.
6. **Extract candidate golden responses.** For each unique `(normalized_endpoint, response_code)`, collect response bodies and hand them to the Phase 8 algorithm. Per ADR 0001 the **authoritative schema source is the OpenAPI spec**; Phase 6 supplies the **observed half** that tightens it (and the only source when the spec lacks an operation). With bodies off, this step contributes nothing and Phase 8 falls back to spec-only goldens — that is expected, not an error. Store candidates under `golden-responses/`. (Format/merge/versioning logic lives in Phase 8; Phase 6 just feeds the observed input.)
7. **CLI.** `npm run ingest -- --from ... --to ...` writes `data/sessions/session-flows-<runId>.json` and the golden candidates, printing a summary.

## Data contract: session-flow record

```json
{
  "session_id": "sess-...",
  "started_at": "2026-06-13T10:00:00Z",
  "ended_at": "2026-06-13T10:02:11Z",
  "role_observed": ["guest", "customer"],
  "steps": [
    {
      "method": "GET",
      "normalized_endpoint": "/store/products",
      "response_code": 200,
      "trace_id": "trace-...",
      "timestamp": "2026-06-13T10:00:00Z",
      "request_payload": {},
      "has_error": false
    }
  ]
}
```

Notes:
- `role_observed` is an **array** because a session may transition (guest → customer). Phase 7 uses the highest-privilege value only for validation scoring, never as classifier input.
- `steps[].request_payload` is the reduced payload (plan §7.1) — used later as sample data for generated tests.

## Key decisions

- **No persona field is written.** Ingestion stays label-free by design.
- **Normalization is the load-bearing step** for mining alignment; get the regex list right and keep it tested.
- **Golden extraction is read-only** here — it snapshots schemas, it does not compare. Comparison is Phase 8/10.

## Validation / acceptance

- `npm run ingest` processes ≥50 sessions from a populated index.
- Output JSON groups steps correctly by session and orders them by timestamp.
- Dynamic IDs are normalized (spot-check `/store/carts/{id}` appears, raw cart IDs do not).
- Noisy endpoints are absent from `steps`.
- At least one golden candidate is written per common endpoint (e.g. `GET /store/products`, `POST /store/carts`).
- `role_observed` is present but documented as validation-only.
