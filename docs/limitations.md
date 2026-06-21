# Known limitations and future work

Stated honestly so the demo and thesis claims are defensible. Each limitation
notes how the current design mitigates it.

## Known limitations

### Synthetic traffic is not real production data
All traffic is generated, so the behavior engine is mining a stream we created.
**Mitigation (plan §8):** the generator mixes three sources — scripted backbone
(~70%), LLM-varied flows (~20%, Haiku 4.5), and injected noise (~10%, abandoned/
retry/contamination/shuffle) — and the registered-customer checkout is a
**holdout** present only in LLM-varied traffic. The engine rediscovering it from
statistical co-occurrence (reported as a support count), plus a negative control,
is what makes the discovery claim more than a scripted round-trip. It is still
synthetic; real production logs would be stronger evidence.

### Mining is classical, not deep ML
Flow discovery uses n-gram sequence mining and PrefixSpan with a support
threshold, plus deterministic rule-based persona derivation. There is no
embedding model or neural sequence model. **Mitigation:** classical mining is
explainable end-to-end (you can point at the support count and the rule that fired)
and adequate for the endpoint-sequence shapes in scope. Deep ML is future work,
not a gap in the MVP claim.

### Golden comparison is shape/type, not value
Golden responses assert the **schema** (field presence + leaf types) sourced from
the OpenAPI contract intersected with observed responses — not exact values.
Dynamic fields (`id`, `created_at`, `token`, `cart_id`, …) are explicitly ignored.
**Mitigation:** this is deliberate (ADR 0001) — it catches structural regressions
(removed field, type change, status change) without false failures on dynamic
data. A value-level oracle would need stable fixtures and is out of scope.

### Persona signal depends on the auth gate holding
The emergent customer signal treats a *successful* cart/checkout mutation as a
customer indicator, which is only valid because `requireCustomerAuth` 401s guest
cart mutations (ADR 0003). If that gate were removed, the cart signal would no
longer be sound. **Mitigation:** enforcement (`middlewares.ts`) and documentation
(`build-oas.ts`) import the same `gate-contract.ts`, so they cannot drift; the
Phase 7 report's endpoint-only-vs-cart-signal delta is what proves the gate is
doing the work.

### Single-node ELK, memory-bound on a laptop
Elasticsearch runs single-node with capped heap. Running hundreds of sessions and
indexing on a developer laptop is memory-sensitive. **Mitigation:** memory limits
are set for local dev; bodies are off by default and reduced when on (8 KB cap,
array head + length); validate headroom before large runs.

### Live end-to-end run requires the full Docker stack
The per-phase **offline** checks (`check:phase0`–`12`, and `check:phase14` as the
aggregate) prove every stage's logic against committed fixtures. The fully live
clean run (traffic → Kibana → green report → injected regression → revert) needs
Medusa + ELK up and is the Phase 14 dress rehearsal, documented in
`docs/pipeline.md` and `docs/phase-14-implementation-plan.md`.

### HITL review dashboard is not yet built (Phase 15)
The read-only human-in-the-loop review surface (list discovered flows + generated
tests, filter by persona, mark approved/discarded, persist decisions) is specified
in `docs/phase-15-implementation-plan.md` but not implemented. The skip gate
already reads an approval/discard store when present (ADR 0002), so the data
contract is in place; the UI is the remaining work. Until then, the Phase 14
acceptance items that depend on HITL review remain open.

## Future improvements (plan §19)

- **Embeddings-based clustering** of user behavior, beyond fixed-window n-grams.
- **Anomaly detection** for unusual API sequences as a first-class signal.
- **CI/CD integration** — run the generated suite automatically on each backend change.
- **OpenTelemetry traces** alongside access logs for richer causality.
- **Playwright UI tests** for the storefront and dashboard, not only API tests.
- **Admin-dashboard behavior** as an additional generation source.
- **Live dashboard analytics** — flow/persona/regression trends over time.
- **Full agentic layer** (ADR 0005 / Phase 16) — orchestration, flow ranking,
  drift triage, and log-pattern mining, kept advisory and non-blocking.
