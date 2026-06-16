# Log Ingestion (Phase 6)

Reads raw Medusa request logs from Elasticsearch and turns them into clean,
**session-grouped behavioral sequences** plus **candidate golden responses**.
This is the bridge between "logs exist" (Phases 2–5) and "we can mine behavior"
(Phase 7).

Output is **label-free by design**: grouping, normalization, and denoising only.
No persona is assigned here — Phase 7 derives persona as an emergent attribute
(plan §10.3), so ingestion must never pre-label sessions or the discovery claim
collapses.

## What it produces

- `data/sessions/session-flows-<runId>.json` — one record per session
  (see the data contract below).
- `golden-responses/<endpoint-status>.json` — the **observed half** of the
  ADR 0001 assertion-oracle intersection. Only written when logs carry response
  bodies (`LOG_CAPTURE_BODIES=true`). With bodies-off logs this is empty and
  Phase 8 falls back to spec-only goldens — **expected, not an error**.

## Pipeline

```
ES (behavior-logs-*) ─┐
                      ├─ query → group(by session_id, sort by ts) → normalize
JSONL file (--file) ──┘         → denoise → session-flow records
                                                 └→ golden candidates (observed)
```

Five files, grouped by pipeline stage:

| Module | Responsibility |
| ------ | -------------- |
| `types.ts` | Shared contracts (`RawLogDoc`, `SessionFlow`, `GoldenCandidate`, …). |
| `config.ts` | Env loading + output paths. |
| `source.ts` | **Input** — minimal ES client (PIT + search_after), `source = medusa` + time-range fetch, and the `--file` JSONL source. |
| `pipeline.ts` | **Transform** — `normalizeEndpoint` (**load-bearing — ADR 0002**), denoise, `groupBySession`, `buildSessionFlows`, and `extractGoldenCandidates` (observed-half goldens). Pure functions, no I/O. |
| `run.ts` | CLI entrypoint; writes outputs + prints a summary. |

## Usage

```bash
npm install                       # or: npm run ingest:install (from repo root)

# Against the running ELK stack (default source):
npm run ingest                    # last 24h (INGEST_WINDOW_HOURS)
npm run ingest -- --from 2026-06-13T00:00:00Z --to 2026-06-14T00:00:00Z

# Offline, against a raw JSONL log file (when ELK is not running):
npm run ingest -- --file ../../logs/medusa-json.log --from 2026-06-01T00:00:00Z
```

From the repo root: `npm run ingest:run -- --file logs/medusa-json.log --from <iso>`.

### Flags

| Flag | Meaning |
| ---- | ------- |
| `--from <iso>` | Window lower bound (default: `--to` minus `INGEST_WINDOW_HOURS`). |
| `--to <iso>` | Window upper bound (default: now). |
| `--file <path>` | Read this JSONL log file instead of Elasticsearch. |
| `--quiet` | Suppress the progress/summary log. |

### Config (`.env`)

| Var | Default | Meaning |
| --- | ------- | ------- |
| `ELASTICSEARCH_URL` | `http://localhost:9200` | ES endpoint. |
| `ELASTICSEARCH_INDEX` | `behavior-logs-*` | Index pattern to read. |
| `INGEST_WINDOW_HOURS` | `24` | Default lookback when `--from` is omitted. |

## Data contract: session-flow record

```json
{
  "session_id": "sess-...",
  "started_at": "2026-06-13T10:00:00Z",
  "ended_at": "2026-06-13T10:02:11Z",
  "role_observed": ["guest", "customer"],
  "steps": [
    {
      "method": "POST",
      "endpoint": "/store/carts/{id}/line-items",
      "event": "cart_item_added",
      "status": 200,
      "trace_id": "trace-...",
      "timestamp": "2026-06-13T10:00:30Z",
      "request_payload": {},
      "has_error": false
    }
  ]
}
```

- **`role_observed` is VALIDATION GROUND TRUTH ONLY.** It is the array of raw JWT
  roles seen in the session (highest-privilege last). Phase 7 scores its emergent
  classifier against it but **must never feed it to the classifier** (plan §10.3).
  Mapping: JWT `customer` → `customer`, JWT `user` → `admin`, no/`null` role →
  `guest`.
- `request_payload` is the reduced payload (plan §7.1), reused later as sample
  data for generated tests.

## Session retention rules

- Sessions with no `session_id` are dropped (untraceable; counted in the summary).
- A session is kept when it has **≥2 steps**, OR it is a single **error** step
  (a lone 4xx/5xx still carries edge-case signal, e.g. an unauthenticated admin
  probe). A lone non-error step is dropped (no sequence to mine).
- Noise endpoints are removed from `steps` before the retention check.

## Golden candidates (observed half — ADR 0001)

For each unique `METHOD <normalized endpoint>` + `status`, the response body's
**shape** (field names + leaf types) is snapshotted, dynamic fields
(`id`, `created_at`, `token`, …) are flagged `ignored`, and snapshots are merged
across sessions to surface optional fields. This is **read-only** — it snapshots
schemas, it does not compare (comparison is Phase 8/10). The OpenAPI spec remains
the authoritative oracle; this only tightens it.

## Verify

```bash
# from repo root
npm run check:phase6
```

Validates the latest `data/sessions/` artifact: ≥50 flows, chronological steps,
normalized endpoints (no raw ids, `{id}` present), noise absent, `role_observed`
present, no persona field. Runs offline against the produced output.
