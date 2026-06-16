# Phase 6 — Data Ingestion Service

## Goal

Read raw request logs from Elasticsearch and turn them into clean, session-grouped behavioral sequences plus candidate golden responses. This is the bridge between "logs exist" and "we can mine behavior." Output must be unlabeled by persona — grouping and normalization only — so Phase 7 can perform genuine emergent classification.

## Location

```
services/log-ingestion/
  src/
    types.ts             # shared contracts (RawLogDoc, SessionFlow, GoldenCandidate, …)
    config.ts            # env loading (ES url/index, window hours) + repo-root output paths
    source.ts            # INPUT: ES client (PIT + search_after) + --file JSONL source
    pipeline.ts          # TRANSFORM (pure, no I/O): normalize · denoise · group · sessions · golden
    run.ts               # CLI entrypoint; writes outputs + prints summary
  package.json
data/
  sessions/              # one JSON per run: session-flows-<runId>.json
golden-responses/        # candidate goldens (refined in Phase 8)
```

> Structure note: the conceptual seven-step pipeline below is implemented as
> **five files grouped by pipeline stage** rather than one file per step. The
> input adapters (the former `es-client.ts` + `query.ts`) are merged into
> `source.ts`, which also adds the offline `--file` JSONL reader. All four
> transform steps (the former `normalize.ts`, `denoise.ts`, `group.ts`,
> `sessions.ts`, `golden.ts`) live as labelled sections of the pure-function
> `pipeline.ts`. Shared contracts moved to `types.ts`; env + output-path loading
> to `config.ts`. The Elasticsearch reader uses a **point-in-time + search_after**
> (not the deprecated scroll API).

## Implementation steps

The seven steps below are the conceptual pipeline. Steps 1 (input) live in
`source.ts`; steps 2–6 (transform) are labelled sections of `pipeline.ts`; step 7
is `run.ts`. Shared types live in `types.ts`, config in `config.ts`.

1. **Input (`source.ts`).** Two interchangeable sources produce the same
   `RawLogDoc[]`:
   - `fetchFromElasticsearch` — connect to `ELASTICSEARCH_URL`
     (`http://localhost:9200`), query `ELASTICSEARCH_INDEX` (`behavior-logs-*`) by
     time range (`--from`, `--to`, default last `INGEST_WINDOW_HOURS=24`) and
     `source = medusa`. Pages stably with a **point-in-time + `search_after`**
     (sorted on `timestamp` then `_shard_doc`) so result sets larger than the 10k
     window read cleanly. Pulls only the consumed `_source` fields.
   - `readFromFile` (`--file <path>`) — an offline reader over a raw JSONL log
     file (the same lines Filebeat ships to ES), applying the same `source = medusa`
     + time-window filter. Lets ingestion run when the ELK stack is down.
2. **Group + sort.** Bucket documents by `session_id`; sort each bucket by `timestamp` ascending. Discard sessions with a single step (no sequence to mine) unless they are error-only edge cases worth keeping.
3. **Normalize endpoints.** Replace dynamic segments with placeholders so sequences align across sessions:
   - `/store/carts/cart_01H...` → `/store/carts/{id}`
   - `/store/products/prod_...` → `/store/products/{id}`
   - `/store/carts/{id}/line-items/li_...` → `/store/carts/{id}/line-items/{lineItemId}`
   - `/admin/products/prod_...` → `/admin/products/{id}`
   - The Phase 2 middleware already emits a pre-normalized `endpoint` (dynamic segments collapsed to `{id}`), so this step is mostly a safety re-normalization for anything missed. Sequences can also be keyed on the semantic `event` field (e.g. `cart_item_added`) instead of / alongside `endpoint`.
4. **Denoise.** Drop endpoints irrelevant to behavior (health checks, static assets, favicon, publishable-key probes) via an explicit allow/deny list. Keep the list in one place so it is auditable.
5. **Build session-flow records.** Emit the contract below. Keep `role_observed` (the raw JWT roles seen) **only** for Phase 7 validation — it must be clearly marked as ground-truth-not-input. The JWT `actor_type` maps to a normalized observed role: `customer` → `customer`, `user`/`admin` → `admin`, missing/null → `guest` (ranked guest < customer < admin so the array is privilege-sorted). Retention rule: keep a session with **≥2 steps**, OR a single **error** step (a lone 4xx/5xx still carries edge-case signal — e.g. an unauthenticated admin probe); drop a lone non-error step (no sequence to mine). Sessions with no `session_id` are dropped and counted.
6. **Extract candidate golden responses.** For each unique `(endpoint, status)`, collect response bodies and hand them to the Phase 8 algorithm. Per ADR 0001 the **authoritative schema source is the OpenAPI spec**; Phase 6 supplies the **observed half** that tightens it (and the only source when the spec lacks an operation). With bodies off, this step contributes nothing and Phase 8 falls back to spec-only goldens — that is expected, not an error. Store candidates under `golden-responses/`. (Format/merge/versioning logic lives in Phase 8; Phase 6 just feeds the observed input.)
7. **CLI (`run.ts`).** `npm run ingest -- [--from <iso>] [--to <iso>] [--file <path>] [--quiet]` writes `data/sessions/session-flows-<runId>.json` and the golden candidates, printing a summary (raw docs, dropped-no-session, dropped-single-step, buckets, flows, steps, goldens). `--file` resolves relative to `INIT_CWD` so a repo-root path works through the `npm --prefix` proxy. Against ES it fails fast with a clear message if the cluster is unreachable, pointing to `npm run elk:up` or `--file`.

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
      "endpoint": "/store/products",
      "event": "products_listed",
      "status": 200,
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
