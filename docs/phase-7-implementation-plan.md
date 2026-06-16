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
    signature.ts         # canonical flow signature (normalized step-sequence hash) — shared by dedup, gate, emit
    dedup.ts             # dedup + prefix clustering + per-persona cap (uses signature.ts)
    coverage.ts          # load already-covered signatures (generated tests + HITL approvals)
    rank.ts              # score and rank candidates
    naming.ts            # LLM (Opus 4.8) flow naming + anomaly detection
    validate.ts          # classification precision/recall + holdout + control
    run.ts               # CLI entrypoint
  data/
    candidates/          # test-candidates-<runId>.json
    validation/          # classification-report-<runId>.json
```

## Emergent persona derivation

Per discovered flow (a normalized step sequence), compute attributes from step content:

- `requires_auth` = sequence contains an explicit auth/identity endpoint
  (`/auth/customer/*` or `/store/customers`) **OR** a *successful* (2xx) cart/checkout
  mutation (`POST`/`PATCH`/`DELETE` on `/store/carts` or `/store/payment-collections`).
- `is_admin` = sequence contains `/admin/*`
- `has_errors` = sequence contains any 4xx/5xx step

Resolve persona:

| Attributes | Persona |
| --- | --- |
| `is_admin` | `admin_operator` |
| `requires_auth` and not `is_admin` | `registered_customer` |
| neither | `guest_shopper` |

`has_errors` is an **orthogonal overlay** (edge-case flag), not a competing persona. For a whole session that changes role mid-stream, resolve by the highest-privilege attribute reached: `is_admin` > `requires_auth` > guest. Tag output with `persona_source: "emergent_attributes"`.

### Why the successful-cart-mutation signal is required (not optional)

Guest checkout was removed: the `requireCustomerAuth` middleware 401s every cart and
checkout mutation for non-customers (ADR 0003, plan §6.3). This breaks the original
endpoint-only `requires_auth` rule in two ways, so the rule above folds the auth gate's
*response status* into the signal:

1. **Guests are browse-only.** A guest who pokes a cart endpoint gets a 4xx — so a
   *successful* (2xx) cart mutation can only come from a customer JWT. That status is a
   legitimate emergent signal: it is derived from endpoint + response code, never from
   the held-out JWT `user_role`. (A guest's failed cart attempt carries `has_errors`
   instead, which is correct.)
2. **Token reuse hides the auth endpoint.** A large share of returning customers reuse a
   live JWT and emit no `/auth/*` endpoint in the session (the browse calls are
   unauthenticated; only the cart calls carry the token). The endpoint-only rule would
   label these sessions guests, depressing registered_customer recall. Folding the
   successful-cart-mutation signal into `requires_auth` recovers them.

The *magnitude* of this effect — how many customers the endpoint-only rule misses and how
much the cart signal lifts recall — is a **per-run measurement, not a spec constant.** It
depends on the traffic mix and changes whenever traffic is regenerated, so it is reported
in the validation artifact (§Validation), never hardcoded here. The validation step must
emit **both** the endpoint-only baseline and the cart-signal classification so the signal's
value is a measured delta rather than an assertion.

> Premise check before trusting any of these numbers: the cart signal is only sound while
> the `requireCustomerAuth` gate actually enforces (a guest cart mutation 4xx's, so a 2xx
> cart implies a customer). If guest cart mutations ever return 2xx — e.g. the gate is
> mis-registered — the signal misclassifies guests as customers and the measured delta will
> show it. Confirm a guest `POST /store/carts` returns 401 against the live backend before
> reading the classification report as meaningful.

Implementation note for `attributes.ts`: a step counts toward the cart signal only when
`200 ≤ status < 300`. Do **not** read `role_observed` or the `session_id` source tag here
(the §guardrail) — the status code is part of the flow content, the JWT role is not.

## Mining steps

1. **n-gram baseline.** Slide windows (n = 2,3,4) over normalized endpoint sequences; count frequencies. Fast, explainable, good for a demo contrast against PrefixSpan.
2. **PrefixSpan.** Mine frequent variable-length sequential patterns across sessions with a configurable `minSupport`. **Use an absolute support floor (`minSupport = 3` sessions), not a fraction of `N`** (see "Support threshold: absolute floor, not fractional" below). This finds full journeys with optional intermediate steps.
3. **Markov chain.** Build a transition-probability matrix between normalized endpoints; use it for anomaly hints and to flag low-probability transitions — a supporting signal, not the primary generator.
4. **Compare n-gram vs PrefixSpan** output and keep the comparison in the run summary (useful for the writeup).

## Support threshold: absolute floor, not fractional

`minSupport` is an **absolute floor of 3 sessions**, never `~0.05 × N`. This is a
binding decision, not a tunable preference, because it is what lets edge-case
(`has_errors`) behavior survive into candidates.

Rationale — keep the traffic realistic, fix the threshold instead:

- The traffic generator stays realistic (plan §4, Phase 5). Edge sessions are an
  honest ~2% of the mix and run a **randomized 3–5 of 6** error cases
  (`services/traffic-generator/src/flows/edge.ts`), so per-case support is thin —
  ~4 sessions at the realistic default of 300. A fractional threshold
  (`0.05 × 300 = 15`) would silently discard every one of them, and the suite
  would generate **no negative tests at all** despite the errors being present in
  the logs.
- The fix is analysis-side, not traffic-side: an absolute floor of 3 keeps thin
  negative flows without distorting the mix. **Do not** raise the edge weight,
  add an edge floor in the traffic generator, or make `edge.ts` deterministic to
  compensate — those distort realism. The realistic lever for more edge coverage
  is **more total traffic**, not engineered injection (e.g. ~1000 sessions →
  ~13 support per edge case).

**Edge coverage is frequency-weighted, and that is correct.** The dominant source
of negative logs is not the contrived `edge.ts` bucket but **organic errors riding
on high-volume flows** — invalid-promo 400/422 (`promoAttempt 0.25 × promoInvalid
0.45` ≈ 11% of every cart/checkout flow), `retryOn4xx 0.5` retries, and
`contaminate 0.08` guest→customer bleed. Generated edge tests therefore skew toward
errors real users actually hit often (bad promo codes, expired/missing-token 401s,
retries) and away from rare contrived ones. This is the log-driven discovery thesis
working as intended, not a gap to patch: rare error paths that never appear in
realistic traffic legitimately get no test (ADR 0001 — generation is log-driven, the
OAS is the oracle, not the generator).

## Flow signature (one definition, shared) — `signature.ts`

Every "is this the same flow?" question in the pipeline uses **one** key: a stable
hash of the **normalized step sequence** — the ordered list of `METHOD
normalized_endpoint` tokens (dynamic segments already collapsed by ingestion, e.g.
`/store/carts/{id}/line-items`). **Persona is not part of the key** — identity is the
endpoint sequence, not its derived label. `signature.ts` is the single source of this
function; `dedup.ts` (below), the cross-run skip gate, and Phase 9's `emit.ts` all
call it rather than recomputing it (see ADR 0002).

## Dedup / clustering (before ranking, plan §12.1)

- Collapse flows with **identical** normalized step sequences (compared by
  `signature.ts`) → keep highest support.
- Cluster flows sharing a **common prefix of ≥3 steps** → keep the longest representative.
- Cap output at **10 canonical flows per persona** to prevent test-suite bloat.

This is a **within-run** collapse only. Cross-run "already has a test" filtering is
the separate skip gate below.

## Ranking

Score each candidate by a weighted sum of: support, persona coverage, endpoint importance (checkout/auth weigh higher than browsing), error coverage, and business importance. Emit a sorted list. Keep weights in one config object so they are tunable and explainable.

## Cross-run skip gate (before LLM naming) — `coverage.ts` (ADR 0002)

The within-run dedup above collapses duplicates *inside* a single run. It does **not**
stop a flow that was already discovered, named, emitted as a test, and reviewed in a
previous run from being re-processed. The skip gate closes that gap and is the answer
to "where do we skip flows that already have a test?".

Placement — between ranking and LLM naming:

```
mine → dedup (within-run) → rank → [SKIP GATE] → naming (LLM) → candidates
```

1. **Build the coverage manifest** (`coverage.ts`): the set of already-covered flow
   signatures, from two sources —
   - the generated test corpus: every `generated-tests/**/*.spec.ts`, read back via
     the signature each test stamps on itself (Phase 9 `emit.ts`);
   - the Phase 15 HITL approval JSON store: entries marked `approved` **and** entries
     marked `discarded` (a human-rejected flow must not re-surface every run).
2. **Filter ranked flows.** For each ranked canonical flow, compute its `signature`.
   If it is in the manifest, **drop it before the LLM call** — no naming, no
   anomaly/assertion call — and exclude it from the emitted candidate set so Phase 9
   does not regenerate it.
3. **Record, don't hide.** Count skipped flows in the run summary as
   `skipped_existing`. A run that mines only already-covered behavior should report
   `skipped_existing > 0` and few/zero new candidates — legible, not broken.

On a clean checkout with no prior tests, the manifest is empty and every flow is
treated as new (correct by construction). Only the flows surviving this gate reach the
LLM, so LLM judgment cost scales with *new* behavior, not total behavior.

## LLM use (Opus 4.8, `claude-opus-4-8`) — judgment only, never classification

- **Flow naming:** sequence → human name ("Returning customer abandons cart after applying promo"; "Guest browses three products and leaves").
- **Anomaly / contamination detection:** flag sessions with out-of-persona endpoints; judge contamination vs. legitimate guest→customer transfer.
- **Assertion recommendation:** suggest which response fields matter for a flow's golden check (consumed in Phase 9).

These are low-volume calls. Classification stays deterministic.

## HITL scope: persona is a read-only derived label

The platform dashboard's human-in-the-loop review (the HITL Review Dashboard phase in plan §16) lets the human review **flows and generated tests** — browse, approve, discard. The human does **not** set persona. Persona is an *output* of the emergent classification above and is attached to each candidate as a read-only label.

- This is a hard rule: making persona human-editable would reintroduce manual labeling and collapse the "discovered from sequences alone" claim — the HITL would silently become the labeler.
- Persona is still useful in the UI as a **view dimension**, not a control: group/filter the review queue by persona, show per-persona coverage. That is display, not assignment.
- A reviewer *can* shift a flow's persona, but only indirectly — by editing its **steps**. If an edit adds or removes a signal that feeds the attributes — an auth/identity step (`/auth/customer/*`, `/store/customers`, `/admin/*`) or a successful cart/checkout mutation — the `requires_auth`/`is_admin` attributes recompute and persona re-derives. Persona always remains a function of flow content, even after a human edit; it is never a field the reviewer types.

## Output contract: test candidate

A guest example is browse-only — carts are auth-gated, so a real guest flow never
reaches `/store/carts` with a 2xx (see "Auth-gated cart signal"):

```json
{
  "flow_name": "Guest shopper browses catalog and views a product",
  "persona": "guest_shopper",
  "persona_source": "emergent_attributes",
  "attributes": { "requires_auth": false, "is_admin": false, "has_errors": false },
  "priority": "medium",
  "support": 27,
  "source_sessions": ["sess-...","sess-..."],
  "steps": [
    { "method": "GET", "endpoint": "/store/regions", "expected_status": 200 },
    { "method": "GET", "endpoint": "/store/products", "expected_status": 200 },
    { "method": "GET", "endpoint": "/store/products/{id}", "expected_status": 200 }
  ]
}
```

A returning-customer checkout that reused a live JWT has **no** `/auth/*` endpoint, yet
its successful cart mutations set `requires_auth: true`:

```json
{
  "flow_name": "Returning customer reorders without re-authenticating",
  "persona": "registered_customer",
  "persona_source": "emergent_attributes",
  "attributes": { "requires_auth": true, "is_admin": false, "has_errors": false },
  "priority": "high",
  "support": 18,
  "source_sessions": ["sess-...","sess-..."],
  "steps": [
    { "method": "GET", "endpoint": "/store/products", "expected_status": 200 },
    { "method": "POST", "endpoint": "/store/carts", "expected_status": 200 },
    { "method": "POST", "endpoint": "/store/carts/{id}/line-items", "expected_status": 200 },
    { "method": "POST", "endpoint": "/store/carts/{id}/complete", "expected_status": 200 }
  ]
}
```

## Validation (the defensible claims)

Write `data/validation/classification-report-<runId>.json` with:

1. **Classification accuracy.** Compare each session's emergent persona against the highest-privilege `role_observed` ground truth; report precision/recall per persona and a confusion matrix. Emit this for **two rule variants on the same data** — the endpoint-only baseline and the endpoint+cart-signal rule — so the cart signal's contribution is a measured delta. This report is the single source of truth for all classification figures; the plan deliberately states no run-specific counts.
2. **Holdout recovery.** Confirm PrefixSpan recovered the registered-customer checkout sequence and report its **support count** (e.g. "support 6"), not a yes/no.
3. **Negative control.** Confirm no high-support flow corresponds to a sequence that was never injected (guard against hallucinated discovery).

The run summary additionally reports `skipped_existing` — the count of ranked flows
dropped by the cross-run skip gate because they already have a test or approval
decision (ADR 0002) — so an incremental run that produces few new candidates is
explained rather than mistaken for a failure.

## Acceptance

- ≥5 test candidates produced from mined flows.
- Registered-customer checkout discovered despite no scripted equivalent, with a reported support count.
- Classification report shows per-persona precision/recall against ground truth, for
  both the endpoint-only baseline and the cart-signal rule.
- The cart signal is **net-positive**: it raises registered_customer recall versus the
  endpoint-only baseline **without lowering overall macro-F1** (on the enforcing-gate
  backend, guest cart mutations 4xx, so the signal should not steal guest recall). If
  macro-F1 drops, the gate is not enforcing — stop and fix the gate, not the rule.
- Negative control passes.
- Per-persona output capped at 10 canonical flows.
- At least one `has_errors` (edge-case) flow survives mining into the candidate set
  on the realistic profile, confirming the absolute support floor (`minSupport = 3`)
  admits negative behavior. Report its support count in the run summary.
