# Phase 7 — Behavioral Modeling Engine

## Goal

Turn unlabeled session-flow records into ranked test candidates. This is the intellectual core of the project and the primary "AI" claim. Two things must be true and demonstrable:

1. **Persona is emergent.** It is derived from flow *content*, never from a pre-assigned label or the JWT role. The JWT `user_role` is used only afterward, as held-out ground truth, to score classification accuracy.
2. **Discovery is genuine.** The engine recovers the registered-customer checkout flow even though it was never scripted (holdout, plan §8.4), and a negative control confirms it does not invent flows that were never injected.

> Guardrail for implementation: no code path in mining or classification may read `session_id` source tags or `role_observed` before producing flows and personas. Those are validation inputs only. If you find yourself branching on them, stop — that is the circularity bug the whole design avoids.

## Location

```
services/behavior-engine/
  src/
    load.ts              # read data/sessions/*.json
    attributes.ts        # derive requires_auth / is_admin / has_errors per flow
    persona.ts           # resolve persona from attributes (emergent)
    ngram.ts             # n-gram mining (baseline)
    prefixspan.ts        # variable-length frequent sequence mining
    markov.ts            # transition probabilities (supporting signal)
    dedup.ts             # dedup + prefix clustering + per-persona cap
    rank.ts              # score and rank candidates
    naming.ts            # LLM (Opus 4.8) flow naming + anomaly detection
    validate.ts          # classification precision/recall + holdout + control
    run.ts               # CLI entrypoint
  data/
    candidates/          # test-candidates-<runId>.json
    validation/          # classification-report-<runId>.json
```

## Emergent persona derivation

Per discovered flow (a normalized step sequence), compute attributes from endpoint content:

- `requires_auth` = sequence contains `/auth/customer/*` or `/store/customers`
- `is_admin` = sequence contains `/admin/*`
- `has_errors` = sequence contains any 4xx/5xx step

Resolve persona:

| Attributes | Persona |
| --- | --- |
| `is_admin` | `admin_operator` |
| `requires_auth` and not `is_admin` | `registered_customer` |
| neither | `guest_shopper` |

`has_errors` is an **orthogonal overlay** (edge-case flag), not a competing persona. For a whole session that changes role mid-stream, resolve by the highest-privilege attribute reached: `is_admin` > `requires_auth` > guest. Tag output with `persona_source: "emergent_attributes"`.

## Mining steps

1. **n-gram baseline.** Slide windows (n = 2,3,4) over normalized endpoint sequences; count frequencies. Fast, explainable, good for a demo contrast against PrefixSpan.
2. **PrefixSpan.** Mine frequent variable-length sequential patterns across sessions with a configurable `minSupport` (start ~0.05 of sessions or an absolute floor like 3). This finds full journeys with optional intermediate steps.
3. **Markov chain.** Build a transition-probability matrix between normalized endpoints; use it for anomaly hints and to flag low-probability transitions — a supporting signal, not the primary generator.
4. **Compare n-gram vs PrefixSpan** output and keep the comparison in the run summary (useful for the writeup).

## Dedup / clustering (before ranking, plan §12.1)

- Collapse flows with **identical** normalized step sequences → keep highest support.
- Cluster flows sharing a **common prefix of ≥3 steps** → keep the longest representative.
- Cap output at **10 canonical flows per persona** to prevent test-suite bloat.

## Ranking

Score each candidate by a weighted sum of: support, persona coverage, endpoint importance (checkout/auth weigh higher than browsing), error coverage, and business importance. Emit a sorted list. Keep weights in one config object so they are tunable and explainable.

## LLM use (Opus 4.8, `claude-opus-4-8`) — judgment only, never classification

- **Flow naming:** sequence → human name ("Guest abandons cart after applying promo").
- **Anomaly / contamination detection:** flag sessions with out-of-persona endpoints; judge contamination vs. legitimate guest→customer transfer.
- **Assertion recommendation:** suggest which response fields matter for a flow's golden check (consumed in Phase 9).

These are low-volume calls. Classification stays deterministic.

## HITL scope: persona is a read-only derived label

The platform dashboard's human-in-the-loop review (the HITL Review Dashboard phase in plan §16) lets the human review **flows and generated tests** — browse, approve, discard. The human does **not** set persona. Persona is an *output* of the emergent classification above and is attached to each candidate as a read-only label.

- This is a hard rule: making persona human-editable would reintroduce manual labeling and collapse the "discovered from sequences alone" claim — the HITL would silently become the labeler.
- Persona is still useful in the UI as a **view dimension**, not a control: group/filter the review queue by persona, show per-persona coverage. That is display, not assignment.
- A reviewer *can* shift a flow's persona, but only indirectly — by editing its **steps**. If an edit adds or removes an auth step (`/auth/customer/*`, `/store/customers`, `/admin/*`), the `requires_auth`/`is_admin` attributes recompute and persona re-derives. Persona always remains a function of flow content, even after a human edit; it is never a field the reviewer types.

## Output contract: test candidate

```json
{
  "flow_name": "Guest shopper adds product to cart",
  "persona": "guest_shopper",
  "persona_source": "emergent_attributes",
  "attributes": { "requires_auth": false, "is_admin": false, "has_errors": false },
  "priority": "high",
  "support": 27,
  "source_sessions": ["sess-...","sess-..."],
  "steps": [
    { "method": "GET", "endpoint": "/store/products", "expected_status": 200 },
    { "method": "POST", "endpoint": "/store/carts", "expected_status": 200 },
    { "method": "POST", "endpoint": "/store/carts/{id}/line-items", "expected_status": 200 }
  ]
}
```

## Validation (the defensible claims)

Write `data/validation/classification-report-<runId>.json` with:

1. **Classification accuracy.** Compare each session's emergent persona against the highest-privilege `role_observed` ground truth; report precision/recall per persona and a confusion matrix.
2. **Holdout recovery.** Confirm PrefixSpan recovered the registered-customer checkout sequence and report its **support count** (e.g. "support 6"), not a yes/no.
3. **Negative control.** Confirm no high-support flow corresponds to a sequence that was never injected (guard against hallucinated discovery).

## Acceptance

- ≥5 test candidates produced from mined flows.
- Registered-customer checkout discovered despite no scripted equivalent, with a reported support count.
- Classification report shows per-persona precision/recall against ground truth.
- Negative control passes.
- Per-persona output capped at 10 canonical flows.
