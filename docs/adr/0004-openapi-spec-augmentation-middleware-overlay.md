# ADR 0004 — OpenAPI spec augmentation: middleware-injected responses overlaid onto the generated OAS (deterministic, no LLM)

- **Status:** Accepted
- **Date:** 2026-06-19
- **Affects:** Phase 2 (logging + gate middleware), Phase 8 (assertion oracle), Phase 9 (script generation)
- **Amends:** ADR 0001 (assertion oracle) — error-step statuses are no longer observed-only where the overlay documents them.

## Context

The assertion oracle is the OpenAPI contract (ADR 0001), and the suite must
assert both **happy-path and error responses**. Two facts make Medusa's
generated spec insufficient on its own:

1. **Generators read routes + validators, not middleware.** Medusa produces its
   OAS from route definitions and their validators. Our `requireCustomerAuth`
   gate (`apps/medusa/apps/backend/src/api/middlewares.ts`) returns `401` for
   unauthenticated cart/checkout mutations *before* the route handler runs. It is
   declared in no validator, so no regeneration of Medusa's spec will ever
   include it. The same is true of any supplemental contract that lives outside
   Medusa's published routes — ADR 0003 already foresaw "a supplemental OAS
   fragment merged in Phase 8" for the admin reversal sequence.
2. **We will not fork Medusa's core routes.** The gate was deliberately
   implemented as middleware precisely to avoid editing Medusa's route handlers.
   Documenting it must therefore also avoid editing Medusa-owned route source.

So the requirement — *a spec that covers errors + happy path and reflects the
middleware, without changing the Medusa codebase* — cannot be met by generation.
It is met by **augmentation**: generate the base spec untouched, then layer the
middleware/supplemental contracts on top as a separate, declarative step.

A second question was settled here: **does detecting/merging this drift need an
LLM?** No. The work is a status-code presence check plus a schema union — exact
operations with exact answers. An LLM in this path would also make the oracle
non-reproducible (goldens are a regression baseline), which is disallowed.

## Decision

1. **Base spec is generated/downloaded from Medusa and never edited.** It carries
   the happy path and Medusa's own validator errors (400/404/422, etc.).

2. **A deterministic overlay/build step augments the base** (Phase 8,
   `services/golden/openapi/build-oas.ts`). It walks the base spec and, for every
   operation whose `(path, method)` matches a gate rule, injects the middleware's
   response. The same step absorbs ADR 0003's supplemental admin-reversal
   fragments. Output is the augmented Store + Admin spec that `oas-source.ts`
   loads — the base is read-only input, the augmented spec is the artifact.

3. **Single source of truth for the gate contract.** The gate's matchers
   (`/store/carts*`, `/store/payment-collections*`), methods
   (`POST`/`PATCH`/`DELETE`), and `401` error envelope (`GateUnauthorized`) are
   extracted from `middlewares.ts` into one shared module imported by **both** the
   middleware (to *enforce*) and the overlay builder (to *document*). Enforcement
   and documentation cannot drift; a new cart sub-route is picked up automatically
   because it matches the same patterns against the base spec.

4. **Collision rule is a deterministic union — no LLM.** When the base already
   documents the same status (e.g. an operation that already has a `401` for a
   different trigger), the overlay does **not** overwrite it. It unions the two
   response schemas (`oneOf(base, gate)`) and records both trigger conditions in
   the response description. This reuses Phase 8's `schema-merge` logic. *Which*
   error actually fires for a given test step remains behavioral and is confirmed
   by the observed response — middleware runs first, so an unauthenticated step
   hits the gate's `401`, and the logged response disambiguates it structurally
   (the two envelopes differ).

5. **Error steps the overlay covers become spec-sourced, with provenance.** Where
   the augmented spec documents an error response, the golden for that error step
   is `schema_source: "openapi"`/`"openapi+observed"` and carries
   `oas_operation_id`/`oas_ref`/`oas_version` — instead of falling back to
   observed-only. This refines ADR 0001, which previously sourced *all*
   error-step statuses from observation.

6. **The LLM stays out of the oracle path.** Per ADR 0001 the LLM is scoped to
   naming/anomaly/"which fields matter," never schema or status math. Its only
   permitted role here is an **advisory drift report** — a human-readable summary
   of operations where base and overlay define the same status with different
   schemas — produced *outside* the oracle and never fed into the augmented spec
   (mirrors the "ADVISORY ONLY" stance in `behavior-engine/src/naming.ts`).

## Consequences

**Positive**

- The spec covers errors **and** happy path, and reflects the middleware, with
  zero edits to Medusa-owned route source.
- The oracle stays **deterministic and reproducible** — the augmented spec is a
  pure function of (base spec, shared gate config, supplemental fragments).
- Enforcement and documentation share one source of truth, so the gate's contract
  cannot silently diverge from the spec the tests assert against.
- Gives ADR 0003's "supplemental OAS fragment" a concrete home (the same overlay
  step).

**Negative / trade-offs**

- Adds a build step (`build-oas.ts`) and a shared gate-config module extracted
  from `middlewares.ts`.
- Introduces a dependency on the base Medusa spec being fetchable/generatable as
  the overlay's input.
- Trusts that middleware authors update the shared gate config when they change a
  gate (mitigated: the middleware imports the same module, so a code change that
  bypasses it is visible in review).

## Status of related docs

- ADR 0001 annotated to point here; its "error statuses are observed-only" stance
  is refined by decision 5 above.
- Phase 8 plan: adds the overlay/build step (`build-oas.ts`), the deterministic
  collision-union rule, the shared gate-config input, and matching acceptance
  criteria.
- Phase 2 plan: records that the `requireCustomerAuth` gate's `401` contract is
  exported via the shared gate-config module and documented in the augmented OAS,
  not in Medusa's generated spec.
- `plan.md` §11 annotated to note the augmented spec is the oracle input.
