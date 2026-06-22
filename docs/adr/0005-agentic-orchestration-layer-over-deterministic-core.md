# ADR 0005 — Agentic orchestration/judgment layer over a deterministic core (log-scoped; agents propose, the substrate disposes)

- **Status:** Accepted
- **Date:** 2026-06-19
- **Affects:** Phase 7 (behavioral modeling), Phase 8 (oracle), Phase 9 (script generation), Phase 11 (reporting), new Phase 16 (agent layer)
- **Extends:** ADR 0001 (LLM scope: naming/anomaly/"which fields matter," never schema or status math) and ADR 0004 (the LLM stays out of the oracle path). This ADR adds an *agent* layer but keeps both fences intact.

## Context

The platform is described as an **AI-Driven Behavioral Testing Platform**, and the
question arose whether it should become an **agent system** — an orchestrator plus
specialist agents (rank flows, verify flows, verify generated code, monitor the
spec for staleness). Two facts constrain the answer:

1. **The mandate is log-driven (`context/problem-statement.md`).** The platform must
   *"learn from real production log data"* and *"ensure the generated scripts
   accurately reflect real user actions observed in production."* Any agent that
   **manufactures behavior the logs never contained** — a live-app explorer, an
   adversarial fuzzer that invents malformations — is **out of scope**. The project
   already encodes this discipline (edge cases are observed-only; "never invents a
   new malformation," Phase 9). An agent system here discovers and judges *within
   the observed data*, it does not explore the live system.

2. **The oracle must stay reproducible (ADR 0001, ADR 0004).** Goldens are a
   regression baseline; an LLM deciding pass/fail, authoring assertions, or computing
   schema/status would make the baseline non-reproducible and collapse the project
   into either contract-testing or an untrustworthy LLM grader. The deterministic
   spine (Phase 8 oracle, ADR 0002 flow signature, `checkOasDrift`, `tsc` + execution)
   is what makes log-discovered tests *trustworthy*.

So an agent layer is viable **only if** it sits where judgment is genuinely needed
and **never** on the correctness path. The deterministic work already done is not a
competitor to the agent system — it is the **substrate** the agents need.

## Decision

1. **The boundary (the fence): agents propose; the deterministic substrate disposes.**
   - **Agents do** open-ended judgment: *rank* mined flows by test value, *plan* the
     campaign (budget, ordering, when to regenerate/refresh), *triage* failures and
     drift, *advise* on flow/code quality, and *deep-mine the logs* for latent
     workflows simple sequence mining under-counts.
   - **Deterministic code does** reproducible truth: compute the flow signature
     (ADR 0002), build/resolve the oracle and compare status+schema (ADR 0001/0004),
     detect drift (`checkOasDrift`), compile (`tsc`), and execute (Phase 11). These
     **gate**; agents do not.

2. **No agent on the oracle/correctness path.** No agent authors or edits goldens,
   assertions, expected status, or schemas; no agent issues a pass/fail verdict; no
   agent output is fed back into the augmented spec. This re-affirms ADR 0001 §"LLM
   scope" and ADR 0004 decision #6.

3. **Every agent output is either advisory or frozen.** An agent result may be (a)
   *advisory* — surfaced to the HITL dashboard / run summary, non-gating; or (b)
   *frozen* into a deterministic artifact (e.g. a ranking order, a prioritized
   candidate list) **before** it can influence anything downstream. Nothing an agent
   says reaches a verdict un-frozen.

4. **The agent roster, each placed on the correct side of the fence:**
   - **Orchestrator (planner, not plumber).** Decides *what to do next under
     uncertainty* — exploration/regeneration budget, when goldens should be refreshed
     vs held, ordering when steps are independent. The **plumbing** (run Phase
     5→7→8→9→11 in dependency order) is a deterministic DAG; the LLM is invoked only at
     genuine decision points. An LLM that merely sequences scripts is rejected — that
     is a DAG, and an LLM there adds nondeterminism and cost for no gain.
   - **Flow-Ranker (agent).** Ranks mined-from-logs flows by test value/risk. This is
     the "what to test" judgment ADR 0001 reserves for AI; it cannot be done well
     deterministically. Output is a *frozen* ordering consumed by Phase 9 selection.
   - **Flow-Verifier (advisory).** "Is this mined flow coherent/meaningful?" Advisory
     only. The deterministic check — does the flow round-trip to its ADR 0002
     signature — remains authoritative; the agent does not re-answer it.
   - **Code-Verifier (advisory, NOT a gate).** Reviews generated `.spec.ts` for
     semantic smells (degenerate flow, all-`fixme` bodies). It is **not** the gate:
     `tsc` + signature round-trip + actual execution (Phase 11) are a stronger,
     reproducible check than an LLM reading template-emitted code. (Consistent with
     the Phase 9 plan's "test verification is deterministic" stance.)
   - **Drift-Triage (agent over deterministic detection).** *Detection* is
     deterministic — `oas_version` provenance + `checkOasDrift` already flag stale
     goldens, and that is exact version/schema math (ADR 0004: no LLM). The agent
     *interprets* the drift ("this spec change invalidates these 12 goldens; refresh
     these, hold those, here's why") and proposes action. It never decides staleness.
   - **Log-Pattern-Miner (optional, agent — in scope).** Problem-statement §2
     explicitly sanctions *"Sequence Mining **or** Large Language Models (LLMs) to
     analyze user interaction sequences."* An LLM that surfaces latent/rarer-but-
     meaningful workflows **from the observed logs** is in scope and feeds Phase 7. It
     mines deeper; it does **not** invent behavior or touch the live app.

5. **Out of scope (recorded so future work does not drift):** live-app exploration,
   adversarial/invented inputs, synthetic edge cases not grounded in logs. These
   contradict *"reflect real user actions observed in production."* If a future
   mandate wants them, that is a **new problem statement**, not a Phase 16 extension.

6. **Graceful degradation is mandatory.** Every agent degrades to a deterministic
   fallback when the LLM is unavailable or `AGENT_LAYER=off` (mirrors
   `behavior-engine/src/naming/naming.ts`): Flow-Ranker → support-count ordering; verifiers →
   skipped (deterministic gates still run); Drift-Triage → raw `checkOasDrift` output;
   Orchestrator → the static DAG. **The pipeline runs end-to-end with the agent layer
   disabled** — the agents are an enhancement, never a dependency.

7. **Reproducibility & cost: agents run off the regression hot path.** Planning,
   ranking, mining, and triage run **offline** (generation/analysis time). The
   **regression loop** (Phase 10/11 execution against frozen goldens) stays
   **agent-free**, so CI is deterministic, cheap, and fast.

8. **The agent layer is itself validated against deterministic ground truth
   (meta-eval).** Ranker vs the support-count baseline; Code-Verifier advisories vs
   actual execution outcomes; Drift-Triage recommendations vs raw `checkOasDrift`.
   An agent system that tests software must hold itself to a measurable bar.

9. **Model selection follows existing convention.** Reuse `BEHAVIOR_LLM_MODEL`
   (default `claude-sonnet-4-6`, configurable to `claude-opus-4-8`) for judgment
   calls; `claude-haiku-4-5-20251001` for bulk/low-stakes calls (as plan §10.5 already
   does for narrative generation). No new model surface.

## Consequences

**Positive**
- The platform becomes a genuine **agent system** — orchestrator + specialist agents —
  **without** breaking the reproducibility thesis or the log-driven mandate.
- The deterministic spine is repositioned as the **trustworthy substrate** the agents
  stand on, not as a competitor to "AI-driven."
- Agents are pointed at jobs that genuinely need judgment (rank, plan, triage, deep-
  mine); deterministic code keeps the jobs that need exactness (verify, gate, detect).
- Disabling the agent layer is a no-op for correctness — strong safety property.

**Negative / trade-offs**
- More moving parts (an orchestrator service, per-agent fallbacks, a meta-eval).
- LLM cost/latency at generation time (bounded: off the CI hot path, Haiku for bulk).
- The scope line must be **actively policed** — the live-app-explorer idea is
  attractive and out of bounds; this ADR exists partly to stop that drift.
- A meta-eval burden: the agents must be measured, not assumed good.

## Status of related docs
- **Extends ADR 0001 / ADR 0004:** the LLM's role grows to *agentic planning/ranking/
  triage/log-mining* but stays out of the oracle and off the gate, exactly as those
  ADRs require.
- **Phase 16 plan** (`docs/phase-16-implementation-plan.md`): the agent layer's
  concrete design, agent specs, guardrails, and acceptance.
- **Phase 7** gains an optional LLM Log-Pattern-Miner input (observed-logs-only).
- **Phase 9** Code-Verifier is recorded as advisory, never the gate.
- **`context/checklist.md`** gains a Phase 16 section; **`CLAUDE.md` §7** gains a
  spec-to-task row pointing here.
