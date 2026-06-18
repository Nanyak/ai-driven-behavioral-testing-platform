# Phase 7 — Behavioral Modeling Engine

## Goal

Turn unlabeled session-flow records into ranked test candidates. This is the intellectual core of the project and the primary "AI" claim. Two things must be true and demonstrable:

1. **Persona is emergent.** It is derived from flow *content*, never from a pre-assigned label or the JWT role. The JWT `user_role` is used only afterward, as held-out ground truth, to score classification accuracy.
2. **Discovery is genuine.** The engine recovers the registered-customer checkout flow even though it was never scripted (holdout, plan §8.4), and a negative control confirms it does not invent flows that were never injected.

> Guardrail for implementation: no code path in mining or classification may read `session_id` source tags or `role_observed` before producing flows and personas. Those are validation inputs only. If you find yourself branching on them, stop — that is the circularity bug the whole design avoids.

## Location

Input is **repo-root `data/sessions/`** (PO-1) — `load.ts` resolves the newest
`session-flows-*.json` there by default, mirroring the ingestion service's path
resolution (ingestion *writes* to repo-root `data/sessions/`). It is **not** a
service-local sessions dir. `data/candidates/` and `data/validation/` are
service-local **output** dirs.

```
services/behavior-engine/
  src/
    load.ts              # read repo-root data/sessions/*.json (newest by default)
    attributes.ts        # derive requires_auth / is_admin / has_errors per flow
    persona.ts           # resolve persona from attributes (emergent)
    ngram.ts             # n-gram mining (baseline)
    prefixspan.ts        # variable-length frequent sequence mining
    markov.ts            # transition probabilities (supporting signal)
    signature.ts         # canonical flow signature (normalized step-sequence hash, consecutive dups collapsed) — shared by dedup, gate, emit
    signature.test.ts    # golden/unit test locking the signature (PO-3)
    dedup.ts             # dedup + prefix clustering + per-persona cap (uses signature.ts)
    coverage.ts          # load already-covered signatures (generated tests + HITL approvals)
    rank.ts              # score and rank candidates
    naming.ts            # LLM (Sonnet 4.6, configurable) flow naming + anomaly detection
    env.ts               # .env loader (service .env > repo-root .env) for the LLM key/model
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

> Premise (reworded, PO-2): a *genuinely unauthenticated* guest cart mutation 4xx's
> (the `requireCustomerAuth` gate, ADR 0003), so a **2xx cart mutation implies a held
> token — a customer signal**. The signal is sound only while that gate actually
> enforces. If guest cart mutations ever return 2xx — e.g. the gate is mis-registered —
> the signal misclassifies guests as customers and the measured delta will show it.
> Before concluding the gate leaks, **confirm against the cartWall 401→200 path** that a
> guest `POST /store/carts` returns 401 on the live backend. (Verified on the current
> data: guest `POST /store/carts` returns 401; customer returns 200.)
>
> Ground-truth footnote (PO-2): `role_observed` itself **under-labels** token-reuse and
> login-only sessions as guest — a returning customer reusing a live JWT emits no
> `/auth/*` endpoint, so its only customer trace is the successful cart mutation. Some
> guest→customer reclassifications under the cart-signal variant are therefore
> **ground-truth gaps, not classifier errors**. The validation artifact must footnote
> this so those reclassifications are read correctly (see §Validation).

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
endpoint sequence, not its derived label. Status is not part of the key either.
`signature.ts` is the single source of this function; `dedup.ts` (below), the cross-run
skip gate, and Phase 9's `emit.ts` all call it rather than recomputing it (see ADR 0002).

**Normalization — collapse consecutive duplicates (PO-3).** Before hashing, collapse
runs of identical consecutive `METHOD normalized_endpoint` tokens to one. Status is
already excluded from the key, so a `200`/`304` revalidation pair on the same endpoint
is a no-op repeat that must not split an otherwise-identical flow into two signatures
(it would otherwise affect a large share of sessions). This collapse lives **only** in
`signature.ts` — the single source — so dedup, the skip gate, and Phase 9 emit all see
the same canonical token list. `signature.ts` is built and locked **first**, with a
golden/unit test (`signature.test.ts`).

## Dedup / clustering (before ranking, plan §12.1)

- Collapse flows with **identical** normalized step sequences (compared by
  `signature.ts`) → keep highest support.
- Cluster flows sharing a **common prefix of ≥3 steps** → keep the longest representative.
- Cap output at **10 canonical flows per persona** to prevent test-suite bloat.

This is a **within-run** collapse only. Cross-run "already has a test" filtering is
the separate skip gate below.

## Ranking

Score each candidate by a weighted sum of: **support**, **persona coverage**,
**endpoint importance** (checkout/auth/admin weigh higher than browsing), and
**error coverage**. **Business importance is merged into endpoint importance**
(PO-7): "business importance" and "endpoint importance" were two names for the
same idea — revenue/identity/state-changing endpoints matter more than reads — so
they are one signal, not double-counted. Keep **all** weights in one config object
with explicit defaults so ranking is tunable and explainable.

**Deterministic ordering (PO-5).** Both PrefixSpan output and the final candidate
ranking are pinned: by **support desc, then pattern length desc, then lexicographic
signature** (the ranked list adds score desc as the primary key, falling back to
that same chain on ties). The same input always yields the same ordered output.

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

**Tolerance (PO-6 / BA-F8).** `coverage.ts` must treat a **missing** `generated-tests/`
directory or a **missing** (or malformed) HITL store as an **empty manifest, never an
error**. All filesystem access is best-effort and degrades to "nothing covered yet" —
an empty manifest on a clean checkout means every flow is new, which is exactly the
intended steady-state-vs-clean-checkout behavior.

## LLM use (Sonnet 4.6, `claude-sonnet-4-6` by default) — judgment only, never classification

The naming model is configurable via `BEHAVIOR_LLM_MODEL` (default
`claude-sonnet-4-6`; set it to `claude-opus-4-8` for the most capable naming).
The key and model are read from `services/behavior-engine/.env` (falling back to
the repo-root `.env`), so `npm run mine` picks them up without exporting into the
shell; with no key set, naming degrades to deterministic offline names and the
deterministic classification pipeline is unaffected. Adaptive thinking
(`thinking: {type: "adaptive"}`) is valid on Sonnet 4.6.

- **Flow naming:** sequence → human name ("Returning customer abandons cart after applying promo"; "Guest browses three products and leaves").
- **Anomaly / contamination detection:** flag sessions with out-of-persona endpoints; judge contamination vs. legitimate guest→customer transfer.
- **Assertion recommendation (ADVISORY ONLY — BA-F1):** suggest which response
  fields matter for a flow's golden check, emitted as **optional metadata**
  (`assertion_hints`) on each candidate. This is explicitly **not** a Phase 8/9
  oracle: ADR 0001 keeps the OpenAPI contract (intersected with observed
  responses) as the assertion oracle. The hints are a hint for the human/Phase 9,
  never a source of truth, and the output contract marks them `source:
  advisory_llm` (or `advisory_fallback` when the LLM is unavailable). They must
  not contradict ADR 0001.

These are low-volume calls. Classification stays deterministic. When
`ANTHROPIC_API_KEY` is unset the engine degrades to deterministic local naming and
empty advisory hints, so the pipeline runs end-to-end offline — naming is a
convenience, not a gate.

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

1. **Classification accuracy.** Compare each session's emergent persona against the highest-privilege `role_observed` ground truth; report precision/recall per persona and a confusion matrix. Emit this for **two rule variants on the same data** — the endpoint-only baseline and the endpoint+cart-signal rule — so the cart signal's contribution is a measured delta. This report is the single source of truth for all classification figures; the plan deliberately states no run-specific counts. The report **footnotes** that `role_observed` under-labels token-reuse/login-only sessions (PO-2), so some guest→customer reclassifications under the cart-signal variant are ground-truth gaps, not classifier errors.
2. **Holdout recovery (BA-F2).** Confirm PrefixSpan recovered the registered-customer checkout backbone (`register → cart → line-items → complete`) and report its **support count**, not a yes/no. Acceptance is **support ≥ 6** — the Phase 5 holdout floor — reported as a count and comfortably above `minSupport = 3`.
3. **Negative control (BA-F3 / PO-Q2) — a concrete fixture, not prose.** Assert that no high-support (≥ `minSupport`) mined flow contains a sequence the traffic generator provably never injects:
   - a *successful* (2xx) `POST /store/returns` — store returns were removed by ADR 0003, so the only such steps in real logs are 4xx; the fixture asserts **zero** 2xx store-returns across the sessions; and
   - an admin→customer-checkout chimera (`POST /admin/returns` followed by a customer `POST /store/carts/{id}/complete` in one mined flow). No session mixes an admin reversal with a customer checkout completion.
   Pass condition: both fixtures have support 0 / below the floor. `validate.ts` checks this directly, not in prose.
4. **Contamination resolution (BA-F6/F7).** Assert that every contaminated guest→higher-role session **that carries a content privilege-signal** (an auth endpoint, a 2xx cart mutation, or `/admin/*`) resolves to the **highest-privilege** persona. Sessions with no content signal are the ground-truth gaps from item 1's footnote — reported, not failed. Keep the n-gram-vs-PrefixSpan comparison in the run summary (BA-F6).
5. **Reversal-archetype coverage.** The traffic generator injects **three** admin reversal archetypes (ADR 0003): return+refund (F3), order-cancel (F5), and return-reject (F6 — a requested return declined via `POST /admin/returns/{id}/cancel` with **no** refund). All three are admin-role and should mine as **distinct** admin flows; F6's distinguishing signature is the return-request prefix followed by `/admin/returns/{id}/cancel` with **no** receive/refund step. Note: F6 *is* an injected flow, so the `/admin/returns/{id}/cancel` sequence must **not** be added to the item-3 negative control's never-injected set.

The run summary additionally reports `skipped_existing` — the count of ranked flows
dropped by the cross-run skip gate because they already have a test or approval
decision (ADR 0002) — so an incremental run that produces few new candidates is
explained rather than mistaken for a failure.

## Acceptance

- ≥5 test candidates produced from mined flows.
- Registered-customer checkout discovered despite no scripted equivalent, with a
  reported support count; acceptance is **support ≥ 6** (the Phase 5 holdout floor, BA-F2).
- Classification report shows per-persona precision/recall against ground truth, for
  both the endpoint-only baseline and the cart-signal rule.
- The cart signal is **net-positive**: it raises registered_customer recall versus the
  endpoint-only baseline **without lowering overall macro-F1** (on the enforcing-gate
  backend, guest cart mutations 4xx, so the signal should not steal guest recall). If
  macro-F1 drops, **confirm against the cartWall 401→200 path that the gate enforces
  before concluding the gate leaks** (PO-2) — the rule is correct while a guest
  `POST /store/carts` returns 401.
- Negative control passes (the concrete fixture in §Validation item 3).
- Per-persona output capped at 10 canonical flows.
- **At least one candidate per non-error persona** (`guest_shopper`,
  `registered_customer`, `admin_operator`) is produced (BA-F5).
- At least one `has_errors` (edge-case) flow survives mining into the candidate set
  on the realistic profile, confirming the absolute support floor (`minSupport = 3`)
  admits negative behavior. Report its support count in the run summary.
