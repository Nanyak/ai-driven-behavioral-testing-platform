# ADR 0002 — Cross-run flow-signature skip gate: don't re-name or re-generate flows that already have a test

- **Status:** Accepted
- **Date:** 2026-06-14
- **Affects:** Phase 7 (behavioral modeling), Phase 9 (script generation), Phase 15 (HITL review)

## Context

The Phase 7 dedup step (`docs/phase-7-implementation-plan.md` §"Dedup / clustering")
collapses duplicate flows **within a single mining run** — identical normalized
step sequences are merged, ≥3-step common prefixes are clustered, output is capped
at 10 per persona. That is the only deduplication in the design.

It leaves a gap. Each run is independent: a flow discovered last week, named by the
LLM, emitted as a `.spec.ts`, and approved by a human in the HITL dashboard will be
**re-discovered, re-named by the LLM, and re-emitted** on the next run. There is no
"have I already produced a test for this flow?" check across runs. Two costs follow:

1. **Wasted LLM judgment.** Phase 7's `naming.ts` calls the judgment LLM (Sonnet 4.6 by default, `BEHAVIOR_LLM_MODEL`-configurable to Opus 4.8) for flow naming,
   anomaly/contamination detection, and assertion recommendation. Re-running it for
   a flow that already has a test spends tokens to reproduce a decision already made.
2. **Suite churn and lost human decisions.** Re-emitting a `.spec.ts` for an
   already-covered flow either overwrites a human-reviewed file or creates a
   duplicate, and a flow a reviewer previously **discarded** silently comes back.

The user's framing — "skip the LLM from generating test cases that already exist" —
names this gap. (Note: the LLM does *not* write the test code; templates do — see
"LLM is not the generator" below. The LLM cost being saved is the `naming.ts`
judgment call.)

A clarification on intent: a flow that already has a test is **not new behavior**.
The platform's value is discovering and testing *new or changed* behavior. Spending
LLM calls and emitting files for behavior already covered is pure rework.

## Decision

Add a **cross-run skip gate** keyed on a single canonical **flow signature**, applied
**before** the Phase 7 LLM step.

### 1. Canonical flow signature (one definition, three consumers)

The signature is a stable hash of the **normalized step sequence**: the ordered list
of `METHOD normalized_endpoint` tokens for the flow, where `normalized_endpoint` uses
the same dynamic-segment normalization the ingestion stage already applies
(`/store/carts/{id}/line-items`, not a concrete cart id). **Persona is not part of the
key** — identity is the behavior (the endpoint sequence), not its derived label.

This is the *same* key the within-run dedup already needs. It is defined **once** in
`services/behavior-engine/src/signature/signature.ts` and consumed by three places, which must
never compute it divergently:

- `dedup.ts` — within-run identical-sequence collapse (Phase 7).
- the cross-run skip gate — this ADR (Phase 7).
- `emit.ts` — stamped into each generated test (Phase 9), so the test corpus is
  self-describing and the coverage manifest can be rebuilt from it.

### 2. Coverage manifest (what counts as "already exists")

Before the LLM step, build the set of already-covered signatures from two sources:

- **Generated test corpus** — every `generated-tests/**/*.spec.ts`, read back via the
  signature each test stamps on itself (Phase 9).
- **HITL approval store** — the Phase 15 lightweight JSON store. Entries marked
  `approved` count as covered. Entries marked `discarded` are **also** treated as
  covered, so a flow a human explicitly rejected is not re-surfaced run after run.

### 3. Gate placement and behavior

The gate sits between ranking and LLM naming:

```
mine → dedup (within-run) → rank → [SKIP GATE] → naming (LLM) → candidates → (Phase 9 emit)
```

For each ranked canonical flow, compute its signature. If the signature is in the
coverage manifest, **drop the flow before the LLM call** — no naming, no
anomaly/assertion call — and exclude it from the emitted candidate set so Phase 9
does not regenerate it. Skipped flows are **counted in the run summary**
(`skipped_existing`), never silently discarded, so a run that produces zero new
candidates is legible ("everything mined is already covered") rather than looking
broken.

### 4. LLM is not the generator (reaffirmed)

This ADR keeps ADR 0001's line: the LLM is **judgment only, never the code generator**.
Test `.spec.ts` files are produced by deterministic Handlebars templates
(`script-generator/emit.ts`). We **considered and rejected** having the LLM write
each `.spec.ts` directly:

- It makes the generated suite **non-reproducible** — the same flow yields different
  code run to run, so model noise shows up as test diffs and undermines the regression
  signal the platform exists to produce.
- It costs an LLM call **per test** and requires a compile / `playwright test --list`
  validation gate to catch malformed output.
- It would contradict ADR 0001 and require amending it.

A **Hybrid** escape hatch — templates for the common guest/customer/admin/edge shapes,
LLM only for a flow that genuinely cannot be templated — is recorded as a **deferred
extension**, to be added only when a real flow proves the templates insufficient
(CLAUDE.md §5: no speculative abstractions). Until then, generation stays
fully template-based.

## Consequences

**Positive**

- **LLM cost and suite churn scale with *new* behavior, not total behavior.** Steady
  state, where most mined flows are already covered, costs almost no LLM calls and
  emits almost no files.
- **Regeneration becomes incremental and idempotent.** A signature-derived filename
  (Phase 9) means re-emitting a covered flow is a no-op, not an overwrite or a
  duplicate.
- **Human decisions persist.** Discarded flows stay discarded; approved tests are not
  silently rewritten.
- **One signature, no drift.** A single `signature.ts` shared by dedup, the gate, and
  emit removes the risk of three subtly different "same flow?" definitions.

**Negative / trade-offs**

- Phase 9 `emit.ts` must stamp the signature into each test and derive filenames from
  it — a small added responsibility and a filename convention to honor.
- The gate depends on the generated-tests corpus and the HITL store being readable at
  Phase 7 run time; on a clean checkout with no prior tests the manifest is empty and
  every flow is treated as new (correct, by construction).
- A flow whose normalized sequence changes (e.g. a step added) produces a new
  signature and is correctly treated as new — but a purely cosmetic normalization
  change would do the same, so the normalization rules are now load-bearing and must
  stay stable.

## Status of related docs

- Phase 7 plan: adds `signature.ts` + `coverage.ts`, a "Cross-run skip gate" section
  before LLM naming, and `skipped_existing` in the run summary.
- Phase 9 plan: `emit.ts` stamps the signature and derives filenames from it; the
  defensive dedup re-pass reuses `signature.ts`.
- Phase 15 plan/checklist: the approval JSON store records each entry's flow signature.
- `CLAUDE.md` §7 spec-to-task table points here for cross-run dedup / skip-gate work.
