# ADR 0001 — Assertion oracle: OpenAPI contract (PII-free), intersected with observed responses

- **Status:** Accepted
- **Date:** 2026-06-13
- **Affects:** Phase 2 (logging), Phase 6 (ingestion), Phase 8 (golden handling), Phase 9 (script generation)

## Context

Generated regression tests need two independent things:

1. **What to test** — the flow: which endpoints, in what order, by which persona, with what realistic payloads.
2. **What a correct response looks like** — the assertion oracle: expected status code and response schema.

These have *different* sources of truth, and conflating them causes two failure modes:

- If we drive **generation** from the OpenAPI spec, we have built **contract / conformance testing** — a solved, off-the-shelf category (Schemathesis, Dredd, Postman). It needs no logs and no AI, and it cannot detect behavioral regressions where a schema-valid response is functionally wrong. This would delete the project's contribution.
- If we extract the **assertion oracle** purely from logged response bodies, we must log bodies — which raises a real PII/PCI/secret-exposure problem in any production-like deployment (see the body-capture discussion in Phase 2). It also pins the baseline to "whatever we happened to observe," including incidental optional fields.

A separate, earlier idea — deriving schema from the database DDL — was rejected: API responses are *not* a 1:1 projection of tables (composition, computed totals, pagination envelopes, hidden columns). The DDL is storage shape, not contract shape.

## Decision

Use **two sources of truth for two jobs**, and make the assertion oracle the OpenAPI contract:

| Job | Source of truth |
| --- | --- |
| **What to test** (flow steps, order, persona, sample payloads) | Production logs → behavior engine (Phase 7). Unchanged. |
| **Expected status + response schema** (the assertion oracle) | **OpenAPI spec**, **intersected** with observed responses from logs. |
| Flow naming, anomaly/contamination, "which fields matter" | LLM (Opus 4.8). Unchanged. |

Specifically:

- **`expected_status`** for happy-path steps comes from the OpenAPI operation's documented **success** response. For edge/error steps the specific status (e.g. 401 vs 404 vs 422) comes from the **observed** candidate, since which error occurs is behavioral.
- **`expected_schema`** is **seeded from the OAS response schema** (resolving `$ref`), which is **PII-free by construction** — it is types, not values.
- The OAS schema is **tightened by the intersection** with observed-from-logs schemas, because auto-generated specs are often under-specified (`metadata: object`, `additionalProperties: true`). The spec is the authoritative skeleton; observation narrows it; Phase 8's `schema-merge` performs the union/optionality reconciliation.
- The global **ignore-fields** list for dynamic values (`id`, `created_at`, `token`, …) still applies on top of whichever schema is used.
- Each spec-sourced golden carries **lightweight provenance** — `oas_operation_id`, `oas_ref`, `oas_version` — so any assertion traces back to the exact contract clause it enforces, and a later check can flag a golden whose `oas_version` no longer matches the current spec (drift detection). The spec document itself is *not* vendored into the generated suite (goldens are pre-baked at generation time); only the reference is kept.

Medusa publishes generated OAS for both Store and Admin APIs, so the spec is reasonably in sync with the implementation. We record that this design **trusts the spec to track the implementation**; in a hand-maintained-spec shop, spec-drift detection would be added as its own check.

## Consequences

**Positive**

- **Solves the PII problem.** The oracle no longer requires logged bodies. Production can run **bodies-off** and still produce a valid golden oracle from the spec. Body capture becomes an *enrichment*, not a hard dependency (see Phase 2 relaxation).
- **Authoritative expected status.** Status assertions come from the documented contract, not from "what we happened to see."
- **Keeps the thesis intact.** Generation stays log-driven; the project remains behavioral discovery, not contract conformance.
- **Catches more than the spec alone.** The observed-intersection tightens under-specified spec schemas, so subtle shape regressions the spec is too loose to catch are still detectable.

**Negative / trade-offs**

- Adds an OAS loader/`$ref` resolver to Phase 8 (`oas-source.ts`) and a dependency on the Medusa spec being fetchable/checked-in.
- Two-source merge logic is more code than single-source extraction.
- Trusts spec↔impl sync; a stale spec weakens the oracle (mitigated by the observed-intersection and, later, optional drift detection).

**Where body capture still helps (so the MVP keeps it on in dev):**

- Realistic **sample request payloads** for generated tests (Phase 9 reuses `request_payload`).
- **Tightening** the spec schema against real responses (the observed half of the intersection).

In production these are optional; with bodies off, generated tests fall back to synthesized payloads and spec-only schemas.

## Status of related docs

- Phase 8 plan revised to make OAS the schema source, intersected with observed responses.
- Phase 2 body-capture default relaxed: bodies are enrichment, not a hard requirement for the oracle.
- Phase 6 golden extraction reframed as feeding the *observed half* of the intersection.
- `plan.md` §11 annotated to point here.
