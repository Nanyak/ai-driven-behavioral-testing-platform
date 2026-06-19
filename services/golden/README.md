# Golden Response Handling (Phase 8)

The **assertion oracle**: defines, extracts, stores, and compares golden
responses so regression tests assert on **schema shape and status code**, not
volatile full-body equality. Medusa responses are full of dynamic fields
(IDs, timestamps, tokens) — body-diffing them would produce constant false
regressions. This service snapshots a typed schema with an explicit
ignore-list instead.

This phase owns the *algorithm and utilities only*. Phase 6 (`services/log-ingestion`)
already produces the *observed half* (`GoldenCandidate`); Phase 9/11 will
invoke `compare.ts` during generated-test runs.

## Why the OpenAPI spec is the oracle (ADR 0001, ADR 0004)

Generation (what to test) stays log-driven (Phase 7) — that is this project's
contribution. But the assertion oracle (what a *correct* response looks like)
comes from the **OpenAPI contract**, intersected with observed responses:

- `expected_status` for happy-path steps comes from the OAS operation's
  documented success response.
- `expected_schema` is seeded from the OAS response schema (`$ref` resolved)
  — PII-free by construction (types, not values), so the oracle works even
  with response-body logging off in production.
- The OAS skeleton is **tightened** by observed-from-logs schemas where the
  spec under-specifies a field (see "Real base OAS" below — the real
  `StoreCart` schema turns out to be well-typed, so the bodies-on demo
  instead shows optional-field reconciliation across sessions; `metadata` is
  the one genuinely generic field, and it's on the global ignore list).
- Medusa's spec generator reads routes/validators, **not middleware** — so
  the `requireCustomerAuth` 401 gate is invisible to it. `openapi/build-oas.ts`
  injects that 401 onto every gated cart/payment-collection operation via a
  **deterministic overlay** (no LLM) before `oas-source.ts` ever loads it.
  See `docs/adr/0004-openapi-spec-augmentation-middleware-overlay.md`.
- No ADR 0003 admin-reversal fragment is injected: the real Medusa admin base
  already documents the full reversal surface (`/admin/returns/*`,
  `/admin/payments/{id}/refund`, `/admin/orders/{id}/cancel`, …), so there is
  nothing supplemental to add. ADR 0003's admin-only policy is enforced in the
  storefront/gate and recorded in its ADR — **not** as spec annotations.

## File map

```
services/golden/
  src/
    types.ts          GoldenResponse format + SchemaNode (canonical home now;
                       log-ingestion's identical-shaped type is NOT refactored
                       to import it yet — deferred, see note below)
    ignore-fields.ts   GLOBAL_IGNORE_FIELDS (single auditable source) + per-endpoint hook
    oas-types.ts       Minimal OpenAPI 3 document types shared by oas-source.ts/build-oas.ts
    oas-source.ts      Load the AUGMENTED spec; resolve (method,endpoint,status) -> typed
                       schema + provenance (operationId, $ref, oas_version/content-hash)
    schema-extract.ts  Walk an observed response body -> SchemaNode (the observed half)
    schema-merge.ts    tightenWithObserved (intersect), unionSchema (oneOf/optional-field
                       merge), buildGolden (stamps schema_source + provenance)
    normalize.ts       Strip ignored fields from a live body before compare
    compare.ts         Status compare (short-circuit) + schema diff (missing/unexpected/type-changed)
    version.ts         captured_at stamping, regression-by-default refresh gate, oas_version drift flag
  openapi/
    build-oas.ts        ADR 0004 deterministic overlay (CLI entry: `npm run build-oas`).
                       OFFLINE — reads only the committed `base/`, never the network.
    fetch-base-oas.ts   NETWORKED — bundles the real published Medusa v2 OAS (via
                       `@redocly/cli bundle`) into `base/{store,admin}.json`. The only
                       script in this package that touches the network. Manual,
                       run-when-regenerating-the-base-spec step (CLI: `npm run fetch-base-oas`).
    base/               Checked-in, read-only, REAL bundled Medusa v2 Store + Admin OAS
                       (input; large files, committed as a read-only oracle source —
                       see "Real base OAS" below)
    augmented/          build-oas.ts output (oas-source.ts loads this; gitignored content,
                       .gitkeep checked in — regenerate with `npm run build-oas`)
  test/                 One unit-test file per utility + golden-production.test.ts
                       (end-to-end) + run-all.ts orchestrator
golden-responses/        (repo root) stored goldens, one file per endpoint+status — written
                       by a future ingestion/generation wiring step, not by this library directly
```

## Shared gate-contract relationship (ADR 0004 decision #3)

`apps/medusa/apps/backend/src/api/gate-contract.ts` is the **single source of
truth** for the `requireCustomerAuth` gate: its path matchers
(`/store/carts*`, `/store/payment-collections*`), methods
(`POST`/`PATCH`/`DELETE`), and the `401` `GateUnauthorized` envelope. It is
deliberately dependency-free (no `@medusajs/*` imports) so it loads cleanly
under both:

- **`apps/medusa/.../middlewares.ts`** — imports it to *enforce* the gate
  (`res.status(GATE_UNAUTHORIZED_STATUS).json(GATE_UNAUTHORIZED_BODY)`).
- **`services/golden/openapi/build-oas.ts`** — imports it (via a relative
  cross-package path, loaded under `tsx`) to *document* the same gate in the
  augmented spec.

Enforcement and documentation read the same literals, so they cannot drift —
a new cart sub-route is picked up automatically by both sides because they
match the same matcher patterns.

## How the oracle works: OAS skeleton ∩ observed

For one `(endpoint, status)`:

1. **`oas-source.ts`** resolves the augmented spec's response schema (if any)
   into a flat `SchemaNode` skeleton, plus provenance (`operationId`, `$ref`,
   `oas_version`).
2. **`schema-extract.ts`** walks an observed response body (when bodies are
   on) into the same `SchemaNode` shape, flagging ignore-listed fields as
   `"ignored"`.
3. **`schema-merge.ts`**'s `buildGolden` combines them:

   | OAS entry? | Observed data? | `schema_source` | Notes |
   | --- | --- | --- | --- |
   | yes | yes | `"openapi+observed"` | spec tightened by observation (`tightenWithObserved`) |
   | yes | no | `"openapi"` | bodies-off, or op not yet observed — still a valid oracle |
   | no | yes | `"observed"` | no spec entry; provenance fields are `null` |

4. **`compare.ts`** strips ignore-listed fields from a live response
   (`normalize.ts`) and diffs it against `expected_schema`: status mismatch
   short-circuits as a regression; otherwise missing/unexpected/type-changed
   fields are reported structurally.
5. **`version.ts`** makes baseline updates regression-by-default: a diff is
   never silently absorbed into the stored golden — only an explicit refresh
   updates it. It also exposes `checkOasDrift` so a golden whose
   `oas_version` no longer matches the current spec can be flagged.

## Global ignore-fields list

`id`, `created_at`, `updated_at`, `deleted_at`, `metadata`, `token`,
`cart_id`, `order_id`, `trace_id`, `session_id` — kept in `ignore-fields.ts`,
**identical** to `services/log-ingestion/src/pipeline.ts`'s `IGNORE_FIELDS`.
Per-endpoint additions live alongside it (e.g.
`payment_collection.id` for `POST /store/payment-collections`).

## Run

```bash
npm --prefix services/golden install      # or: npm run golden:install (repo root)

npm --prefix services/golden run fetch-base-oas  # or: npm run golden:fetch-base-oas
                                                  # NETWORKED — regenerates openapi/base/*.json
                                                  # from the live published Medusa v2 spec. Manual,
                                                  # only needed when intentionally refreshing the base.
npm --prefix services/golden run build-oas   # or: npm run golden:build-oas  — OFFLINE, deterministic
npm --prefix services/golden test            # or: npm run golden:test
npm --prefix services/golden run typecheck    # tsc --noEmit

npm run check:phase8   # repo root: tsc + tests + overlay/determinism/$ref assertions — OFFLINE
```

`npm test` (`test/run-all.ts`) rebuilds the augmented spec before running
every `*.test.ts` file, so tests never run against a stale artifact.

## Real base OAS — the published Medusa v2 spec, bundled

`openapi/base/{store,admin}.json` is the **real, published Medusa v2 OpenAPI
spec** — not a hand-authored fixture. Medusa publishes its Store and Admin
API references as a **split spec**: a root `openapi.yaml` with external
`$ref`s out to `./components/schemas/*.yaml` files (one schema per file).
That shape isn't directly loadable as a single self-contained document, so
`openapi/fetch-base-oas.ts` bundles it:

```
Store root:  https://raw.githubusercontent.com/medusajs/medusa/develop/www/apps/api-reference/specs/store/openapi.yaml
Admin root:  https://raw.githubusercontent.com/medusajs/medusa/develop/www/apps/api-reference/specs/admin/openapi.yaml
```

via `@redocly/cli bundle <root> --ext json -o openapi/base/<name>.json`
(pinned exact version in `package.json`, not `npx -y` unpinned), which
resolves every external/relative `$ref` into one JSON document with only
internal `#/components/...` refs left. Regenerate with:

```bash
npm --prefix services/golden run fetch-base-oas   # NETWORKED — the only script that hits the network
```

**Committed stats** (as of this bundle): Store — 923,509 bytes, 63 paths, 109
schemas. Admin — 4,592,454 bytes, 255 paths, 468 schemas. Both report
`info.version: "2.0.0"`. Note this is the **OpenAPI spec's own version**,
independent of the `@medusajs/medusa` npm package version (e.g. `2.15.5`) —
they are versioned separately upstream and should not be conflated when
reasoning about drift.

Everything downstream of `base/` — `build-oas.ts` (the ADR 0004 overlay) and
`check:phase8` — is **fully offline and deterministic**: they read only the
committed `base/` files and never touch the network. Only
`fetch-base-oas.ts` is networked, and it is a manual step, run only when
intentionally refreshing the base spec.

Two real-data details this spec required handling that a synthetic fixture
would not have surfaced:

- **Response-level `$ref`s.** Many responses (all `401`s in particular) are
  `{ $ref: "#/components/responses/unauthorized" }` pointing into a *shared*
  `components/responses/*` registry, not inlined per-operation. Both
  `oas-source.ts` and `build-oas.ts` resolve these (separately — read-time
  vs. build-time-mutation-safe) before reading `.content`. When `build-oas.ts`
  unions the gate 401 onto a shared response, it writes an **inlined copy** on
  that operation rather than mutating the resolved object in place, since the
  same shared response is `$ref`'d by dozens of unrelated operations.
- **`allOf` composition.** `StoreProductListResponse` is `allOf [pagination
  fragment, products fragment]`, not a flat object — `flatten()` in
  `oas-source.ts` merges `allOf` branches the same way it already merged
  `oneOf` branches.
- **Cross-media-type union.** The real base's `401`s are `text/plain`
  ("Unauthorized" as a bare string), while the gate's `GateUnauthorized` is
  `application/json`. The union logic falls back to the first available
  media type when `application/json` is absent on the existing side, and
  `unionFlat` was fixed to prefer the structured object branch over a bare
  string leaf when unioning (previously it silently dropped the object side
  when the two branches had mismatched shapes).

Because the real spec **already documents a `401` on every gated cart/
payment-collection operation** (Medusa's own `unauthorized` response), the
ADR 0004 overlay only ever exercises the **union** collision path against
real data — never the pure-add path. The pure-add path (a gated op with no
prior `401` at all) is real overlay logic that still needs coverage, so
`test/build-oas.test.ts` additionally drives `applyGateOverlay` directly
against a small synthetic in-memory `OasDocument` to cover that branch. Real
data and synthetic fixture are kept in clearly separate, labeled sections in
that test file — never blended into one assertion.

`oas_ref` provenance is `null` for a unioned `401` (there is no single
top-level `$ref` once the response is a `oneOf`) even though `schema_source`
is still `"openapi"` — see `oas-source.ts`'s `findRef` doc comment and
`test/golden-production.test.ts`'s "overlay-documented error step" check.

## Relationship to `services/log-ingestion`

`services/log-ingestion/src/types.ts` defines its own `SchemaNode`/`SchemaLeaf`/
`GoldenCandidate` types with the identical recursive shape. This phase's
`src/types.ts` is now the **canonical** definition — log-ingestion is
**intentionally not refactored** to import it in this phase (out of scope
per the Phase 8 brief); a later phase can re-point that import. Until then,
the two definitions are kept structurally identical by hand so Phase 6's
`GoldenCandidate` output feeds straight into `schema-merge.ts` without any
conversion step.

## Deferred / out of scope for this phase

- End-to-end wiring that reads `services/log-ingestion` `GoldenCandidate`
  output, calls `buildGolden`, and writes files into `golden-responses/` —
  that orchestration belongs to whichever later phase actually runs ingestion
  + golden generation together (Phase 9/11 consume `compare.ts` directly).
  This phase ships the algorithm and unit-tests it end-to-end in-process
  (`test/golden-production.test.ts`), per the brief's "this phase owns the
  algorithm and utilities" framing.
- Re-pointing `services/log-ingestion`'s `SchemaNode` import at this
  package's `src/types.ts` (noted above).
- Content-hash-based provenance (`oasContentHash` exists and is used as an
  `oas_version` fallback when `info.version` is absent, but the real spec
  always has one — so it's unused in practice today). Stricter drift
  detection could pin a content hash of `base/` alongside `info.version` to
  also catch upstream spec edits that don't bump the version string; not
  required for this phase's acceptance criteria.
