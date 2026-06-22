# Behavior Engine (Phase 7)

Turns **unlabeled** session-flow records (Phase 6 output) into **ranked,
persona-tagged test candidates**. This is the project's "AI" core, and it must
make two claims demonstrable:

1. **Persona is emergent** — derived from flow *content* (endpoint + status),
   never from a pre-assigned label or the JWT role. The JWT `role_observed` is
   used **only afterward**, as held-out ground truth, to score accuracy.
2. **Discovery is genuine** — PrefixSpan recovers the registered-customer
   checkout flow even though it was never scripted (the holdout), and a negative
   control confirms it does not invent flows that were never injected.

> **Guardrail (CLAUDE.md §8, plan §10.3):** no code path in mining or
> classification reads `session_id` source tags or `role_observed` before
> producing flows and personas. `attributes.ts` reads **endpoint + status only**.
> Those ground-truth inputs reach `validate.ts` and nothing else.

## Input / output

| | Location | Notes |
| --- | --- | --- |
| **Input** | repo-root `data/sessions/session-flows-*.json` | Newest by default; mirrors the ingestion service's path resolution (PO-1). Override with `--file`. |
| **Candidates** | `data/candidates/test-candidates-<runId>.json` | Service-local. Ranked, named, persona-tagged candidates for Phase 9. |
| **Validation** | `data/validation/classification-report-<runId>.json` | Service-local. The single source of truth for all classification figures (no run-specific numbers are hardcoded in the plan). |

## Run

```bash
npm install                 # or: npm run behavior:install (repo root)
npm run mine                # mine the newest data/sessions artifact
npm run mine -- --file ../../data/sessions/session-flows-XXXX.json
npm run mine -- --min-support 3 --quiet

# from repo root:
npm run behavior:mine
```

### LLM config (optional — naming only)

Flow naming uses the LLM; classification is fully deterministic and never calls
it. Copy `.env.example` to `.env` and set the key (the file is gitignored):

```bash
# services/behavior-engine/.env
ANTHROPIC_API_KEY=sk-ant-...
BEHAVIOR_LLM_MODEL=claude-sonnet-4-6   # default; override to claude-opus-4-8, etc.
```

Resolution is `process.env` > service `.env` > repo-root `.env` (same as the
traffic generator), so `npm run mine` picks the key up without a shell export.
With no key set, naming falls back to deterministic local names and every
acceptance gate still passes.

### Flags

| Flag | Meaning |
| --- | --- |
| `--file <path>` | Mine a specific session-flows artifact (default: newest in `data/sessions/`). |
| `--min-support N` | PrefixSpan absolute support floor (default **3** — a binding decision, never a fraction of N). |
| `--quiet` | Suppress the run summary. |

## Pipeline

```
load (repo-root data/sessions)  → canonical tokens (signature/)
  → mine: n-gram baseline (n=2..4) ‖ PrefixSpan (closed, gap-bounded) ‖ Markov
  → assemble + classify mined flows  (per-flow modal status from each flow's OWN
       supporting sessions, not global; classification/; endpoint+status)
  → dedup (within-run: identical-sig collapse, contiguous-subsequence subsumption)
  → rank (one weight config)  →  cap 10/persona AFTER ranking, balanced clean/error
  → [SKIP GATE]  (selection/coverage.ts — drop already-covered signatures; ADR 0002)
  → naming (LLM Sonnet 4.6 — judgment only; offline fallback when no API key)
  → write candidates + validation report + run summary
```

### Layout

`src/` groups modules by pipeline stage; `run.ts` is the CLI entry point that
wires them in the order above.

```
src/
  run.ts                  CLI orchestrator + run summary (entry point)
  config/env.ts           .env loader (LLM key/model)
  io/sessions.ts          load session flows from repo-root data/sessions/
  signature/              the one canonical flow signature (+ golden test)
  mining/                 ngram · prefixspan · markov
  classification/         attributes → persona (emergent, deterministic)
  selection/              dedup · rank · coverage (skip gate)
  naming/                 LLM annotation (judgment only)
  validation/             classification report (the only role_observed reader)
```

### Modules

| Module | Responsibility |
| --- | --- |
| `signature/signature.ts` | **The one** canonical flow signature (ADR 0002). Stable SHA-256 over the ordered `METHOD endpoint` token list, **with consecutive duplicates collapsed** (a 200/304 revalidation pair is a no-op repeat). Persona and status are **not** part of the key. Shared by dedup, the skip gate, and Phase 9 emit. Locked first; golden test in `signature/signature.test.ts`. |
| `io/sessions.ts` | Reads repo-root `data/sessions/` (newest `session-flows-*.json`). |
| `classification/attributes.ts` | Deterministic `requires_auth` / `is_admin` / `has_errors` from **endpoint + status only**. Three rule variants (ADR 0006): endpoint-only baseline; the cart-signal rule (a *successful* 2xx cart/checkout mutation ⇒ `requires_auth`); and the read-signal rule (a *successful* 2xx **auth-gated read** — `GET /store/orders`, `GET /store/customers/me` — also ⇒ `requires_auth`). The read set excludes guest-permitted reads (`GET /store/orders/{id}` 404s for guests). The production rule = cart + read. |
| `classification/persona.ts` | Resolve persona from attributes (highest privilege wins). `has_errors` is an orthogonal overlay, not a persona. |
| `mining/ngram.ts` | Fixed-window (n=2,3,4) session-support baseline — a demo contrast for PrefixSpan. |
| `mining/prefixspan.ts` | **Closed** sequential pattern mining with a `maxGap` bound and per-root fairness (so a high-volume browse root cannot starve admin reversals). Deterministic ordering (PO-5): support desc, length desc, lexicographic. |
| `mining/markov.ts` | First-order transition model; low-probability transitions are anomaly hints for naming (supporting signal only). |
| `selection/dedup.ts` | Within-run identical-sig collapse + **contiguous-subsequence subsumption** (drop a flow that is a contiguous sub-run, ≥2 tokens, of a longer kept flow of the same persona — generalizes prefix clustering; collapses mid-checkout fragments into the full journey). The per-persona cap of 10 is `capRankedPerPersona`, applied by the caller AFTER ranking (so value, not raw support, decides survivors) and **balanced** across the has_errors split (reserve ~half each persona's cap for clean vs error flows, else error flows — routed to `edge/` — empty the persona's own folder). All "same flow?" comparisons go through `signature.ts`. |
| `selection/coverage.ts` | Cross-run coverage manifest + skip gate. Reads `generated-tests/**/*.spec.ts` (signature stamp) and the HITL store (`approved` + `discarded`). A **missing** dir/store is an **empty** manifest, never an error (PO-6). |
| `selection/rank.ts` | One config object with explicit weights: support, persona coverage, endpoint importance (**business importance merged in** — PO-7), error coverage. |
| `naming/naming.ts` | LLM (Sonnet 4.6, `claude-sonnet-4-6` by default; `BEHAVIOR_LLM_MODEL` overrides — e.g. `claude-opus-4-8`; adaptive thinking) — naming, anomaly/contamination, and **advisory** assertion hints (BA-F1; never a Phase 8/9 oracle — ADR 0001 keeps the OAS authoritative). Raw HTTPS so the service stays dependency-light; degrades to deterministic local names when `ANTHROPIC_API_KEY` is unset. |
| `config/env.ts` | `.env` loader (precedence `process.env` > service `.env` > repo-root `.env`) for the LLM key/model, mirroring the traffic generator. Put the key in `services/behavior-engine/.env` (gitignored) so `npm run mine` finds it without a shell export. |
| `validation/validate.ts` | The defensible claims (below). The **only** reader of `role_observed`. |
| `run.ts` | CLI orchestrator + run summary. |

## Validation report

`data/validation/classification-report-<runId>.json` emits:

1. **Three rule variants on the same sessions** (ADR 0006) — `endpoint_only`
   baseline, `cart_signal`, and `cart_read_signal` (production) — with per-persona
   precision/recall, a confusion matrix, macro-F1, and the **measured delta** for
   each status-derived signal (cart-signal delta vs baseline; read-signal delta vs
   cart-signal) — so each signal's value is measured, not asserted.
   - **Footnote (PO-2):** `role_observed` under-labels token-reuse / login-only
     sessions as guest (a returning customer reusing a live JWT emits no
     `/auth/*` endpoint). Some guest→customer reclassifications under the
     cart/read-signal variants are therefore **ground-truth gaps, not classifier
     errors**. A status signal is sound only while the `requireCustomerAuth`
     gate enforces — confirm a guest `POST /store/carts` (and `GET /store/orders`)
     returns 401 before concluding the gate leaks.
2. **Holdout recovery** — PrefixSpan support count for the registered-customer
   checkout backbone (`register → cart → line-items → complete`). Acceptance =
   **support ≥ 6** (the Phase 5 holdout floor, BA-F2), reported as a count.
3. **Negative control** (BA-F3, a concrete fixture, not prose) — no high-support
   mined flow contains a *successful* (2xx) `POST /store/returns` (removed by
   ADR 0003; the only such steps in logs are 400s) nor an admin-return →
   customer-checkout chimera. Pass = both below the floor.
4. **Contamination resolution** (BA-F7) — every contaminated guest→higher-role
   session that carries a **content** privilege-signal resolves to the
   highest-privilege persona. Sessions with no content signal are the
   ground-truth gaps from the footnote (reported, not failed).

## Acceptance gates (run summary + `npm run check:phase7`)

≥5 candidates · holdout support ≥ 6 · cart signal net-positive · read signal
net-positive (registered_customer recall up, macro-F1 not down; ADR 0006) ·
negative control passes · ≥1 edge (`has_errors`)
candidate survives · per-persona cap of 10 · ≥1 candidate per non-error persona ·
contamination → highest privilege.

## Verify

```bash
npm run check:phase7    # repo root
```

Runs the signature golden test, a clean `tsc --noEmit` (hard gate), and validates
the latest candidate + validation artifacts against every acceptance gate.
Offline; mine first with `npm run behavior:mine`.

## Hard rules (do not break)

- **Persona is never part of the signature key** and is never human-editable
  (a reviewer changes it only indirectly, by editing steps — plan §HITL scope).
- **The holdout is LLM-only** — the engine *discovers* it; it is never injected.
- **`minSupport` is an absolute floor of 3**, never a fraction of N — this is
  what lets thin edge (`has_errors`) behavior survive into candidates.
- **Classification is deterministic.** The LLM is judgment only (naming,
  anomaly/contamination, advisory hints) — never a classifier.
