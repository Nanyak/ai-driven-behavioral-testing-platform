# Phase 16 — Agentic Orchestration & Judgment Layer

## Goal

Add an **agent layer** over the existing log-driven pipeline (Phases 5–11) so the
platform is a genuine *agent system* — an orchestrator plus specialist agents — while
keeping the deterministic spine authoritative. Agents **propose** (rank, plan, triage,
advise, deep-mine the logs); deterministic code **disposes** (verify, detect drift,
gate). See ADR 0005. The layer is strictly **log-scoped** (problem-statement mandate)
and **non-blocking**: disabling it is a no-op for correctness.

> This is an enhancement phase. It does not change the oracle (Phase 8), the flow
> signature (ADR 0002), or how goldens are produced. It changes *what runs when*, *which
> flows are prioritized*, and *how failures/drift are explained* — and adds an optional
> deeper log miner feeding Phase 7.

## Non-goals (binding — ADR 0005 §5)

- **No live-app exploration.** Agents never drive the running system to discover new
  behavior.
- **No invented flows.** The Log-Pattern-Miner surfaces patterns **present in the
  observed logs**; it does not fabricate sequences with unobserved steps or transitions.
- **No agent on the correctness path.** No agent authors goldens/assertions/status, and
  no agent issues a pass/fail verdict.
- **No LLM in the regression hot loop.** Phase 10/11 execution stays agent-free.

## Location

```
services/agent-orchestrator/
  src/
    orchestrator.ts        # planner: decides next action under uncertainty; static DAG is the fallback
    dag.ts                 # deterministic pipeline DAG (Phase 5→7→8→9→11 dependency order) — the plumbing
    tools.ts               # deterministic tools agents may CALL (read-only over existing outputs)
    agents/
      flow-ranker.ts       # rank mined flows by test value/risk -> frozen ordering
      flow-verifier.ts     # advisory: is a mined flow coherent/meaningful?
      code-verifier.ts     # advisory: semantic smells in generated .spec.ts (NOT a gate)
      drift-triage.ts      # interpret checkOasDrift output -> refresh/hold recommendations
      log-pattern-miner.ts # OPTIONAL: deeper mining of OBSERVED logs -> Phase 7 candidates
    fallback.ts            # per-agent deterministic degradation (AGENT_LAYER=off or LLM unavailable)
    report.ts              # agent-run summary (advisories, rankings, triage) for the HITL dashboard
    config.ts              # BEHAVIOR_LLM_MODEL reuse; AGENT_LAYER flag; budgets
    run.ts                 # CLI entrypoint
  data/agent-runs/         # timestamped agent-run artifacts (advisory; never a baseline)
  test/                    # unit tests + meta-eval harness
```

## The fence (which side each agent is on)

| Agent | Side | Gates? | Output | Deterministic fallback |
| --- | --- | --- | --- | --- |
| **Orchestrator** | planner | no | next action / schedule | static DAG (`dag.ts`) |
| **Flow-Ranker** | judgment | no (frozen) | ordered candidate list | support-count ordering (Phase 7) |
| **Flow-Verifier** | advisory | no | per-flow note | skipped (signature round-trip still runs) |
| **Code-Verifier** | advisory | **no** | per-test smell note | skipped (`tsc` + `--list` + execution still gate) |
| **Drift-Triage** | judgment over det. detection | no | refresh/hold recommendation | raw `checkOasDrift` list |
| **Log-Pattern-Miner** | judgment (in-scope mining) | no | observed-grounded candidates | classical miner only (Phase 7) |

**Deterministic tools the agents may call (read-only; they never recompute these):**
`flowSignature` (ADR 0002), `checkOasDrift` + `oas_version` (Phase 8 `version.ts`),
candidate support counts (Phase 7), `tsc --noEmit` / `playwright test --list`, and
Phase 11 execution results. Agents *read* these signals and reason over them; the
signals themselves stay deterministic.

## Per-agent specs

### Orchestrator (planner, not plumber)
- **In:** pipeline state (which artifacts exist/are stale), budgets, drift signals.
- **Decides:** exploration/regeneration budget, when to **refresh** vs **hold** goldens
  (never auto-refresh — ADR 0001 §"refresh is explicit"; the agent *recommends*, a human
  or a flag confirms), and ordering when steps are independent.
- **Does not:** sequence dependency-ordered steps with an LLM — that is `dag.ts`. The LLM
  is invoked only at genuine decision points.
- **Fallback:** execute the static DAG end-to-end.

### Flow-Ranker
- **In:** Phase 7 candidates (flows, support, persona label, assertion hints).
- **Out:** a **frozen** ranked ordering consumed by Phase 9 selection (which ≤10/persona
  to emit first). Risk/value judgment — the "what to test" job ADR 0001 reserves for AI.
- **Meta-eval:** ranking must beat or track the support-count baseline on a held-out
  measure (e.g. regression-catch rate per the Phase 12 demo); recorded, not assumed.
- **Fallback:** support-count descending.

### Flow-Verifier (advisory)
- **In:** a mined flow + its ADR 0002 signature.
- **Out:** advisory note ("coherent" / "degenerate: lone GET" / "suspicious: auth gap").
- **Authoritative check stays deterministic:** the flow must round-trip to its signature
  — the agent does not re-answer that.
- **Fallback:** skipped.

### Code-Verifier (advisory, NOT a gate)
- **In:** a generated `.spec.ts`.
- **Out:** semantic-smell advisory (all-`fixme` bodies, no meaningful assertion, flow
  collapsed to one step).
- **Hard rule:** does **not** decide pass/fail. `tsc` + signature round-trip + actual
  execution (Phase 11) are the gate. (Phase 9 plan already states verification is
  deterministic; this agent only adds an advisory smell-pass.)
- **Fallback:** skipped.

### Drift-Triage (agent over deterministic detection)
- **In:** `checkOasDrift` output (which goldens' `oas_version` ≠ current spec) + the
  base/overlay schema diffs.
- **Out:** a recommendation — "refresh goldens A,B (breaking field removed); hold C,D
  (additive only); these N tests will fail until refreshed" — for human/flag action.
- **Hard rule:** detection is `checkOasDrift`; the agent never decides *whether* a golden
  is stale, only *what to do about it*.
- **Fallback:** emit the raw `checkOasDrift` list.

### Log-Pattern-Miner (optional; in-scope mining only)
- **In:** the ingested **observed** session flows (Phase 6 output).
- **Out:** additional Phase 7 candidates that are **latent in the logs** — long-range,
  interleaved, cross-session, or rare-but-real sequences the frequency-biased classical
  miners under-count.
- **Boundary (ADR 0005 §4/§5 — enforced, not just documented):**
  - Every emitted step **and every transition** must be **present in the observed logs**.
    A candidate containing an unobserved step or an unobserved transition is **rejected**
    at emit (deterministic check against the observed transition set), not shipped.
  - **Recombined/generalized** candidates (observed primitives stitched into a longer
    observed-grounded flow) are **labeled `synthetic_source: "log-recombination"`**, kept
    **out of the observed regression baseline**, and may carry **spec-only** goldens
    (`schema_source: "openapi"`) — never an observed golden, because none exists.
  - It **never** fabricates a flow no session performed. Coverage-beyond-production is a
    different mandate (own ADR), explicitly not this agent.
- **Fallback:** classical miners only (Phase 7 unchanged).

## Architecture (two-speed)

- **Discovery/planning/triage (offline, agentic, budgeted):** orchestrator plans;
  ranker/miner/verifiers/triage run at generation/analysis time. LLM calls live here.
- **Regression (CI, deterministic, agent-free):** Phase 10/11 run the frozen suite
  against frozen goldens. No agent in this loop.

The orchestrator's plumbing is a deterministic DAG; the LLM is consulted only at decision
points. `AGENT_LAYER=off` runs the DAG with every agent in fallback — proving the layer
is non-blocking.

## Implementation steps

1. Build `dag.ts` (deterministic pipeline graph) and `tools.ts` (read-only wrappers over
   `flowSignature`, `checkOasDrift`, support counts, `tsc`/`--list`, Phase 11 results).
2. Implement each agent with its **fallback first**, then the LLM path on top (so the
   deterministic baseline always exists). Mirror `behavior-engine/src/naming.ts`:
   degrade silently to fallback when the LLM is unavailable.
3. Wire the Log-Pattern-Miner's **observed-transition guard** as a hard deterministic
   filter at emit; unit-test the rejection of unobserved steps/transitions.
4. Freeze Flow-Ranker output into the Phase 9 selection input; freeze nothing else.
5. Emit an agent-run report (`report.ts`) for the HITL dashboard (Phase 15): advisories,
   ranking, triage recommendations — clearly marked advisory, never a verdict.
6. Add the meta-eval harness (`test/`) and `scripts/check-phase16.mjs`.
7. Wire root scripts: `agent:run`, `check:phase16`.

## Validation / acceptance (unit-tested + meta-eval)

- **Non-blocking:** the full pipeline runs end-to-end with `AGENT_LAYER=off` (all agents
  in fallback) and produces the same goldens/verdicts as without the layer.
- **Fence held:** no agent writes a golden/assertion/status; no agent emits a pass/fail;
  static analysis confirms agents only *read* the deterministic tools.
- **Flow-Ranker** produces a deterministic frozen ordering; meta-eval shows it tracks or
  beats the support-count baseline on the Phase 12 regression-catch measure.
- **Code-Verifier** advisories are surfaced in the run summary and **do not** change which
  tests pass (a test the agent dislikes but that compiles+runs+asserts still passes).
- **Drift-Triage** recommendations are consistent with `checkOasDrift` (it never
  contradicts the deterministic staleness flag).
- **Log-Pattern-Miner boundary:** a crafted candidate containing an unobserved
  step/transition is **rejected**; a recombined candidate is **labeled synthetic**, kept
  out of the observed baseline, and carries only spec-sourced goldens. A purely invented
  flow is never emitted.
- **Graceful degradation:** with the LLM unreachable, every agent falls back and the run
  still completes.
