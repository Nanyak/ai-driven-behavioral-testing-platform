# Phase 8 — Golden Response Handling

## Goal

Define, extract, store, and compare golden responses so regression tests assert on **schema shape and status code**, not on volatile full-body equality. Medusa responses are full of dynamic fields (IDs, timestamps, tokens); comparing raw bodies would produce constant false regressions. We snapshot a typed schema with an explicit ignore-list instead.

This phase owns the *algorithm and utilities*. Phase 6 invokes the extraction during ingestion; Phase 9/10 invoke the comparison during test runs.

## Schema source: OpenAPI contract, tightened by observed responses (ADR 0001)

The assertion oracle is the **OpenAPI spec**, not logged bodies. See `docs/adr/0001-assertion-oracle-openapi-contract.md`.

- **`expected_status`** for happy-path steps comes from the OAS operation's documented **success** response. For edge/error steps the specific status comes from the **observed** candidate (which error fires is behavioral).
- **`expected_schema`** is **seeded from the OAS response schema** (resolve `$ref` → typed shape). This is **PII-free by construction** — types, not values — so the oracle does **not** require logged response bodies, and production can run bodies-off.
- The OAS schema is **intersected with observed-from-logs schemas** to tighten it, because Medusa's generated OAS is often under-specified (`metadata: object`, `additionalProperties: true`). The spec is the authoritative skeleton; observation narrows it; `schema-merge` reconciles. With bodies off, fall back to spec-only.
- The global ignore-fields list still applies on top, regardless of source.

> Generation stays log-driven (Phase 7). The OAS is the *assertion oracle only* — driving generation from the spec would collapse this into off-the-shelf contract testing (ADR 0001).

## Location

```
services/golden/                # canonical comparator library; imported by ingestion, vendored into generated-tests by Phase 9
  src/
    oas-source.ts        # load OpenAPI spec, resolve $ref -> typed schema per (operation, status); authoritative skeleton
    schema-extract.ts    # walk observed JSON, classify leaf types (observed half of the intersection)
    schema-merge.ts      # merge/intersect OAS schema with observed; reconcile optional fields across sessions
    ignore-fields.ts     # global + per-endpoint ignore list
    normalize.ts         # strip ignored fields before compare
    compare.ts           # schema compare + status compare -> diff
    version.ts           # captured_at stamping, baseline refresh gate
  test/                  # unit tests for each utility
  openapi/               # checked-in Store + Admin OAS (or a fetch script) used by oas-source.ts
golden-responses/        # stored goldens, one file per endpoint+status
```

## Golden response format (plan §11.4)

```json
{
  "endpoint": "POST /store/carts",
  "expected_status": 200,
  "expected_schema": {
    "cart": { "id": "string", "currency_code": "string", "items": "array" }
  },
  "ignore_fields": ["id", "created_at", "updated_at"],
  "schema_source": "openapi+observed",
  "oas_operation_id": "PostCarts",
  "oas_ref": "#/components/schemas/StoreCart",
  "oas_version": "2.4.0",
  "captured_at": "2026-06-13T10:00:00Z",
  "source_sessions": ["sess-...","sess-..."]
}
```

`schema_source` records provenance: `"openapi"` (spec only — e.g. bodies were off), `"openapi+observed"` (spec tightened by observed responses), or `"observed"` (no spec entry for this operation; fell back to logged bodies). `expected_status` is sourced per the schema-source rules above (spec for success steps, observed for edge/error steps).

**OAS provenance fields** (lightweight, for traceability and future drift detection): when the golden draws on the spec, stamp `oas_operation_id` (the operation it enforces), `oas_ref` (the response schema `$ref` it resolved), and `oas_version` (the spec `info.version`, or a content hash if the spec is unversioned). These let an auditor trace any assertion back to the exact contract clause, and let a later check flag a golden whose `oas_version` no longer matches the current spec. They are `null`/omitted when `schema_source` is `"observed"`.

## Global ignore-fields list

`id`, `created_at`, `updated_at`, `deleted_at`, `metadata`, `token`, `cart_id`, `order_id`, `trace_id`, `session_id`. Per-endpoint additions are allowed (e.g. `payment_collection.id`). Keep the list in `ignore-fields.ts` so it is auditable in one place.

## Algorithm

### Source from OAS (`oas-source.ts`)

1. Load the Store + Admin OpenAPI spec from `openapi/`.
2. For a `(method, normalized_endpoint, status)`, locate the operation and its response schema; resolve `$ref`s into a flat typed shape (`string | number | boolean | array | object | null`). Capture the operation's `operationId`, the resolved response `$ref`, and the spec `info.version` (or a content hash) for provenance stamping.
3. This typed shape is the **authoritative skeleton** and `expected_status` source for success steps. If the spec has no entry for the operation/status, mark `schema_source: "observed"` and rely on extraction below.

### Extraction from observed bodies (`schema-extract.ts`)

1. Walk the response JSON tree (when bodies are present — see Phase 2 capture flag).
2. Classify each leaf as one of `string | number | boolean | array | object | null`.
3. Flag any field matching the ignore-list as `ignored` (excluded from the schema).
4. Build a schema snapshot recording the shape + types of all non-ignored fields. This is the **observed half** of the intersection (and the only source when the spec lacks the operation).

### Intersect + merge (`schema-merge.ts`)

1. **Intersect** the OAS skeleton with the observed schema to *tighten* under-specified spec fields (e.g. spec `metadata: object` stays as-is; spec `items: array` gains element typing observed in logs). Spec is authoritative on field existence; observation narrows types.
2. When multiple sessions hit the same `(endpoint, status)`, **merge** observed schemas so optional fields are captured as optional rather than treated as regressions. Union of keys; type conflicts recorded and surfaced — a type that varies across sessions is itself interesting.
3. Stamp `schema_source` (`openapi` / `openapi+observed` / `observed`) plus the OAS provenance fields (`oas_operation_id`, `oas_ref`, `oas_version`) so every golden traces back to the contract clause it enforces. With bodies off, the result is spec-only (`openapi`).

### Compare (`compare.ts`)

Given a live response and a stored golden:
1. Compare status code first — mismatch is an immediate regression.
2. Strip ignored fields from the live body (`normalize.ts`).
3. Compare the live schema against `expected_schema`: report missing fields, unexpected new fields, and type changes.
4. Return a structured diff (consumed by the Phase 11 report).

### Versioning (`version.ts`)

Goldens carry `captured_at`. A schema change in a test run is a **regression by default** — the baseline is only updated when the developer explicitly re-runs ingestion to refresh it. No silent auto-update.

## Key decisions

- **OAS is the assertion oracle (ADR 0001).** Schema is sourced from the OpenAPI contract — PII-free, authoritative on status — and tightened by observed responses. It does **not** require logged bodies.
- **Oracle ≠ generator.** The spec only supplies assertions; *what* to test stays log-driven (Phase 7). Driving generation from the spec would be contract testing, not behavioral discovery.
- **Schema-snapshot, not body-diff.** Stable regression detection compares typed shape, not volatile values.
- **Status mismatch short-circuits.** A 200→500 is a regression regardless of body.
- **Refresh is explicit.** Prevents goldens from drifting to match a regression.

## Validation / acceptance (unit-tested)

- OAS loads and resolves `$ref` into a typed schema for common operations (`POST /store/carts`, `GET /store/products`).
- `expected_status` for happy-path steps is sourced from the spec; edge/error steps use the observed status.
- A golden is produced with `schema_source: "openapi"` even with bodies off (oracle works without logged bodies).
- With bodies on, an under-specified spec field is tightened by the observed schema (`schema_source: "openapi+observed"`).
- Spec-sourced goldens carry `oas_operation_id`, `oas_ref`, and `oas_version`; a golden whose `oas_version` differs from the current spec can be flagged (drift hook).
- Comparison with a matching response → pass.
- Changed status code → detected as regression.
- Changed schema (new field / removed field / type change) → detected.
- Dynamic fields (id, timestamps, tokens) → never cause a false failure.
- An intentional schema change → flagged as regression until baseline is refreshed.
