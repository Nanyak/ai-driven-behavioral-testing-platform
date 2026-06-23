# Limitations & future work

Honest scope boundaries. Each limitation lists the mitigation already in place and
the future direction. The goal of this document is to make the platform's claims
*defensible* — what it does, what it does not, and what would extend it. See
[`architecture.md`](./architecture.md) and [`pipeline.md`](./pipeline.md).

## Scope boundaries

### 1. Traffic is synthetic, not real production data

The behavioral input is generated, not captured from a live production system.
The traffic generator is **scaffolding that substitutes for production logs we
don't have** — not a product feature. The platform's actual surface starts at the
logging middleware and is source-agnostic downstream.

- **Mitigation.** Traffic is mixed-source (deterministic scripted flows + LLM-varied
  narratives via Haiku 4.5), and the validation methodology relies on a **holdout**:
  the registered-customer `register → login → checkout` backbone exists *only* in
  the LLM-varied stream and is never scripted, so the engine must rediscover it
  statistically rather than replay an injected pattern. A negative control confirms
  the engine does not surface un-injected flows.
- **Future work.** Point the ingestion stage at a real Elasticsearch index from a
  staging/production system. The session-flow contract is source-agnostic — only
  the log shipper changes.

### 2. Mining is classical, not deep ML

Behavior modeling uses n-gram, PrefixSpan, and Markov techniques — not neural
sequence models.

- **Mitigation.** Classical mining is **deterministic, auditable, and
  reproducible** (pinned emission order, absolute support floor), which is exactly
  what makes the persona-accuracy and holdout-recovery numbers trustworthy. The
  measured precision/recall demonstrate the classical approach is sufficient for
  this problem.
- **Future work.** A learned sequence model (e.g. a transformer over endpoint
  tokens) could capture longer-range dependencies and rank candidates by predicted
  business value, with the current deterministic miner kept as a verifiable
  baseline.

### 3. Golden snapshots are shape/type level, not value level

The oracle asserts response **structure** (field existence + JSON types) against
the OpenAPI contract, not exact field values.

- **Mitigation.** This is the deliberate ADR 0001 choice: the OpenAPI contract is a
  stable oracle, whereas logged values are volatile. A shared ignore-fields list
  strips inherently variable fields (`id`, timestamps, tokens, `cart_id`, …). Spec
  leaves are tightened by observed shapes without ever removing spec-declared
  fields, so the oracle is as strict as the contract allows.
- **Future work.** Value-level invariants (e.g. price ≥ 0, total = sum of lines,
  monotonic order states) as an optional assertion layer on top of the shape check.

### 4. ELK is single-node and laptop-bound

Elasticsearch runs as a single node sized for a developer machine.

- **Mitigation.** Sufficient for the demo corpus; ingestion is batch and re-runnable.
- **Future work.** A multi-node cluster + index lifecycle management for
  production-scale log volumes; the ingestion stage already reads through the ES
  query API and would not change.

### 5. The LLM is enrichment, not oracle

The LLM names flows, flags anomalies/contamination, and suggests assertions — it is
**never** on the classification, oracle, or gate path.

- **Mitigation.** This is a feature: it keeps every pass/fail decision deterministic
  and reproducible (ADR 0005). With no API key, naming degrades to a deterministic
  offline fallback and the rest of the pipeline is unaffected.
- **Future work.** Use the LLM to *propose* candidate assertions that are then
  promoted into the deterministic oracle only after human (HITL) approval —
  expanding coverage without compromising determinism.

### 6. Persona model is a fixed three-tier taxonomy

Personas resolve to `guest_shopper`, `registered_customer`, or `admin_operator`
(plus an orthogonal `has_errors` edge overlay).

- **Mitigation.** The taxonomy maps directly to the problem statement's persona
  classes and to Medusa's actual auth tiers, and is derived emergently from
  attributes rather than labeled.
- **Future work.** Unsupervised clustering of attribute vectors to discover
  finer-grained sub-personas (e.g. "promo-driven shopper", "bulk admin importer")
  without predefining them.

### 7. Domain is a single Medusa e-commerce backend

The platform is demonstrated against one REST API surface (Medusa Store/Admin).

- **Mitigation.** The stages are decoupled by file contracts and the oracle is
  OpenAPI-driven, so the approach generalizes to any logged, OpenAPI-described REST
  service.
- **Future work.** A second target backend to prove portability; GraphQL/gRPC
  oracle adapters.

## What is explicitly out of scope

- UI/browser-level end-to-end testing (the generated tests are API-level Playwright
  specs, by design — the assertion target is the API contract).
- Load/performance testing (the platform tests *behavioral correctness*, not
  throughput or latency SLOs).
- Auto-remediation of detected regressions (the platform detects and attributes;
  fixing is left to engineers).

## Summary

The platform makes a narrow, measurable claim — *mine real behavioral sequences,
classify personas emergently, regenerate them as contract-checked tests, and catch
regressions* — and backs each part with a deterministic, reproducible artifact plus
a validation report with precision/recall, holdout recovery, and a negative control.
The limitations above are scoping choices in service of that defensibility, each with
a concrete path to extend.
