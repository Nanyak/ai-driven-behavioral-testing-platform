# Implementation Plan — Loosen over-strict body masking

**Status:** ready for implementation
**Branch:** `db-migration`
**Owner hand-off:** this doc is self-contained; a coding agent should be able to execute it without prior context.

---

## 1. Background (read first)

The SUT (Medusa backend) logs request/response bodies for the testing pipeline. Before writing a body to the log it **masks** sensitive fields. That masking is currently too strict in two ways and has one latent correctness bug.

**Critical fact that bounds the blast radius:** masking only affects **logged** bodies. The actual HTTP response returned to a client/test is never masked — masking lives in the logging middleware (`res.once("finish", …)`), not in the response path. So masked bodies are consumed in only two downstream places:

1. **Golden response schema** (`services/script-generator/src/run.ts` → `services/golden/.../schema-merge`). Goldens are **shape/type** oracles (`compareResponse`), not value oracles. Masking is type-preserving (a hidden number is still a number), so masked values do **not** poison goldens.
2. **Request-body evidence** (`services/log-ingestion` features → `services/behavior-engine` → `candidate.request_body_evidence`). The script generator reads only the `masked` **flag** and `safe_hints`, never raw masked values (see `services/script-generator/src/resolve.ts:635` — masked evidence is treated as "presence only").

The **invariant** subsystem (`services/script-generator/src/invariants/`) is **not** affected: `propose` builds its digest from Medusa workflow source, and `verify` (`evaluate.ts`) runs against a live run's **real unmasked** bodies. It never reads masked logs.

### On this branch, masking is in the golden/mining path

`.env` sets `LOG_CAPTURE_BODIES=true` but leaves `LOG_CAPTURE_RAW_BODIES` at its `false` default (`apps/medusa/apps/backend/src/api/middlewares.ts:40-42`, `:383`). So golden-capture traffic **is** masked. That is why strictness matters here and not only in production logs.

### The three masking layers (they have drifted — that drift is the bug)

The definition of "sensitive" is duplicated in three files:

| File | Purpose | Symbol |
|---|---|---|
| `apps/medusa/apps/backend/src/api/body-redaction.ts` | Hides values in logged bodies | `isSensitiveScalarKey`, `isSensitiveContainerKey`, `SENSITIVE_SCALAR_TOKENS` |
| `services/log-ingestion/src/pipeline.ts` | **Labels** which fields were hidden (`masked_field_paths`) | `SENSITIVE_FIELD_PATTERNS`, `isMaskedValue` |
| `services/script-generator/src/artifacts.ts` | Redacts the human-facing review artifact | `SENSITIVE_FIELD` |

Layers 1 and 2 must agree: whatever layer 1 **hides**, layer 2 must **label**. They currently disagree, and that disagreement is the correctness bug (below).

---

## 2. Problems to fix

### Problem A — Over-hiding non-secret checkout fields
`payment_collection.payment_sessions[]` (and `order.payment_collections[].payments[]`) get fully leaf-masked: `status`, `provider_id`, `amount`, `currency_code` → all hidden. These are **not** secrets — they are the core signals describing checkout behavior. They are hidden by accident because `"payment_sessions"` matches the auth-`session` token via `hasSingularOrPluralPart` in `isSensitiveContainerKey` (`body-redaction.ts:108-115`).

### Problem B (correctness) — Hidden numbers/booleans masquerade as real data
`body-redaction.ts` masks sensitive numbers → `0` and booleans → `false` (`maskSensitiveScalar`, `:187-199`). The downstream label detector only recognizes **string** sentinels (`pipeline.ts:isMaskedValue` returns `false` for non-strings, `:409-415`). A hidden field is *also* labeled when its path matches `SENSITIVE_FIELD_PATTERNS` — but those anchored regexes don't always match the same keys layer 1 hides (e.g. the plural `payment_sessions` gap). Result: a hidden `amount: 0` can be ingested as a **genuine** observation, letting the system learn a false fact like "payment amount is always 0."

> Note: Problem A's fix (stop hiding `payment_sessions`) also removes the specific observed instance of Problem B, because the layer-1/layer-2 disagreement disappears. Problem B's dedicated fix (Task 2) is about preventing the **class** of bug from recurring on other/future fields.

---

## 3. Goal & scope

**Goal:** hide fewer non-secret fields, and guarantee layers 1 and 2 can never silently disagree — without changing what is genuinely secret and without touching the script generator / goldens / invariants.

### Keep hidden (DO NOT CHANGE)
`password`, `passwd`, `pwd`, `passcode`, `token`, `secret`, `authorization`, `cookie`, `session` (auth sense), `csrf`, `jwt`, `credential(s)`, `email`, `phone`, `ssn`, `tin`, `pan`, `cvv`, `cvc`, `api_key`, card/account/document/paper data, `first_name`, `last_name`, street `address_1/2`, `city`, `province`, `company`, geo `latitude/longitude`.

### Now visible (the change)
| Field | Where | Rationale |
|---|---|---|
| `payment_sessions[].{status, provider_id, amount, currency_code, id}` | cart/order responses | checkout behavior, not secrets |
| `payments[].{status, provider_id, amount}` | order responses | same (see depth caveat §7) |

### On generic behavioral fields (`status`, `is_active`, `quantity`, …)
These are **already visible** — verified empirically. Standalone or inside a normal container (`variant`, `item`, `product`, `payment_collection`), fields like `status: "published"`, `is_active: true`, `quantity: 5`, `inventory_quantity` are **not** masked and need no change. A behavioral field is only clobbered when it sits **inside a container the masker flagged** (mask-leaves hits every leaf regardless of name). In Medusa the only place that happens with behavioral fields is `payment_sessions`/`payments` — so **Task 1 (below) is the complete fix**; there is no separate rule to add for status/quantity. Addresses carry no `status`/`quantity`, which is why leaving address masking untouched (see below) loses nothing.

### Geography fields — intentionally left masked
`country_code` / `postal_code` inside address containers **stay masked**. Decision: they don't affect the test spec (region-scoped params are resolved from the live region, not from observed values), so there's no benefit to exposing them. No allowlist, no change to address handling.

### Out of scope
- No changes to script generator, goldens, behavior-engine, or invariants.
- No change to `LOG_CAPTURE_RAW_BODIES` semantics.
- No change to address / geography masking.
- Do **not** implement Problem B (the numeric blind spot) by converting hidden numbers to the string `"[masked]"` — that flips the field's primitive type (number→string), poisoning the golden schema and `primitive_types` evidence, and would force generator/golden changes. Keep numbers as numbers.

---

## 4. Tasks

### Task 1 — Stop hiding the non-secret fields (`body-redaction.ts`)

File: `apps/medusa/apps/backend/src/api/body-redaction.ts`

**1a. De-sensitize payment-scoped session objects.**
In `isSensitiveContainerKey` (`:104-173`), the first block masks any key whose parts include a singular/plural `address|credential|cookie|session` (`:108-115`). Narrow it so a **payment-scoped** key is not caught by the `session` rule — a Medusa *payment session* is a checkout object, not an auth session.

Suggested approach: if `parts.includes("payment")`, do **not** treat `session(s)` as the sensitivity trigger; let the dedicated `payment` rules (`:117-129`) decide. Those rules only mask when a payment part is one of `details|data|payload|method|methods|instrument|instruments` — `sessions` is not among them, so `payment_sessions` becomes non-sensitive. Genuine `session`/`sessions`/`cookies`/`credentials` containers (no `payment` part) must stay masked.

Also confirm the leaves don't get re-hidden by the scalar path: `isSensitiveScalarKey` (`:52-102`) must return `false` for `status`, `provider_id`, `amount`, `currency_code`, `id` (it already does — no token match). Add a unit assertion to lock this in.

This is the **whole** behavioral fix: once `payment_sessions`/`payments` are no longer flagged, their `status`/`amount`/`is_selected`/`quantity` leaves stop being masked (booleans→`false`, numbers→`0`, strings→`[masked]`). No `mask-leaves` allowlist and no address changes are needed.

**Acceptance for Task 1:**
- A Medusa cart body: `payment_collection.payment_sessions[0].status/provider_id/amount/currency_code/is_selected/quantity` are the **real** values, not `[masked]`/`0`/`false`.
- `shipping_address.*` (including `country_code`, `city`, `province`, `first_name`, street) remain `[masked]` — address handling is unchanged.
- `email`, `phone`, card/token/secret/password everywhere remain masked.

### Task 2 — Guarantee layer-1 / layer-2 symmetry (fixes Problem B class)

**Recommended: single source of truth.** Extract the "is this key sensitive?" decision into one module that both `body-redaction.ts` (to hide) and `pipeline.ts` (to label) import, so they cannot drift. Precedent exists for cross-package import: `services/log-ingestion/checks/body-features.check.ts` already imports from the Medusa app path. Put the predicate where both can reach it (e.g. alongside `body-redaction.ts`, or a small shared file), exporting something like `isSensitiveKey(key): "scalar" | "container" | null`. Then:
- `pipeline.ts:hasPatternMatch`/masked-labeling checks each path segment with the shared predicate instead of the standalone `SENSITIVE_FIELD_PATTERNS`.
- After Task 1, the shared predicate reports `payment_sessions`/`payments` as **non**-sensitive, so both layers agree they're visible.

**Minimum viable alternative (if cross-package wiring is too costly):** keep the lists separate but add a **symmetry property test** (see Task 3) that feeds many keys/bodies through both layers and fails if layer 1 hides a value that layer 2 does not label — including numeric/boolean masks. This catches the Problem B class without a refactor.

Pick one. The shared module is preferred (kills the root cause); the property test is the floor.

**Acceptance for Task 2:** there is no field for which `body-redaction` produces a masked value (`[masked]`, `0`, or `false`) that `pipeline` fails to include in `masked_field_paths`. Enforced by test.

### Task 3 — Update / extend tests

File: `services/log-ingestion/checks/body-features.check.ts`

This file hard-codes expected `masked_field_paths` (`:138-179`). Update to reflect the new rules and add coverage:
- **Add** a `payment_collection.payment_sessions[]` case asserting `status`/`provider_id`/`amount`/`currency_code` are **present and not masked**, and **not** in `masked_field_paths`.
- **Keep** existing PII assertions (`$.shipping_address.latitude`, `.verified`, `$.payment_details.amount` stay masked — `payment_details` and addresses are still sensitive; only `payment_sessions`/`payments` change).
- **Add** the symmetry check from Task 2 (numeric/boolean masked values are always labeled).

Also add unit assertions in `body-redaction`'s own test surface (or the check file) for the Task 1 acceptance bullets.

Run existing masking tests and fix any that legitimately changed:
```bash
# whichever the repo uses to run the log-ingestion checks / body-redaction tests
npx tsx services/log-ingestion/checks/body-features.check.ts
```

### Task 4 — Regenerate artifacts & verify end-to-end

No generator code changes are needed, but the on-disk goldens/candidates were built from over-masked data and should be refreshed:

1. Capture fresh traffic with bodies on (`LOG_CAPTURE_BODIES=true`, already set).
2. Re-run the pipeline: **ingest → mine → generate** (dashboard `/api/pipeline/run`, or the CLI steps the repo uses).
3. Review the diff of `golden-responses/*.json` — expect real `payment_sessions[].status`/`provider_id` strings where `[masked]` used to be; **schema/shape must be unchanged**.
4. Regenerate a few specs and confirm generated request bodies still resolve (watch for any step that now skips because a field changed between hint-driven and placeholder-driven synthesis — see §7).

---

## 5. Files to touch (summary)

| File | Change |
|---|---|
| `apps/medusa/apps/backend/src/api/body-redaction.ts` | Task 1 (+ shared predicate export if Task 2 preferred path) |
| `services/log-ingestion/src/pipeline.ts` | Task 2 (consume shared predicate, or keep + rely on property test) |
| `services/log-ingestion/checks/body-features.check.ts` | Task 3 (update expectations + add symmetry/new-field cases) |
| `golden-responses/*.json` (generated) | Task 4 regen output — review, don't hand-edit |

**Do NOT touch:** `services/script-generator/**` (generator, goldens, invariants), `services/behavior-engine/**`, `artifacts.ts` (its own redaction layer intentionally keeps the review artifact clean — leaving it as-is means no new PII in human-facing output; only change it if you *want* the loosened fields visible in the review manifest).

---

## 6. Acceptance criteria (definition of done)

- [ ] Cart/order logged bodies show real `payment_sessions[].{status,provider_id,amount,currency_code,is_selected,quantity}`.
- [ ] `email`, `phone`, names, street address, `city`, `province`, `country_code`, card/token/secret/password remain masked.
- [ ] No masked value (`[masked]`, `0`, `false`) escapes `masked_field_paths` — proven by a symmetry test.
- [ ] `body-features.check.ts` passes with updated + added cases.
- [ ] Golden schema/shape unchanged after regen (values differ, types don't).
- [ ] Generated suite still runs; no new step skips traced to this change.

---

## 7. Risks & caveats

- **Privacy:** payment `status`/`provider_id`/`amount` now appear in log files and golden JSON on disk. Low-sensitivity (not names/emails/cards — those stay masked), but a small increase in shared-log content. Addresses/geography are untouched.
- **Generated-body drift:** unhiding fields exposes new `safe_hints`; `resolve.ts` may now synthesize a field from an observed value instead of a placeholder (or vice-versa). Usually an improvement — verify a few specs (Task 4 step 4).
- **Depth truncation is separate:** `order.payment_collections[].payments[]` sits at `MAX_DEPTH` (`body-redaction.ts:9`, `=4`) and collapses to `"[object]"` **before** masking even applies. Unhiding won't reveal it. If those order-`payments` fields are needed, that's a separate `MAX_DEPTH` decision — out of scope here.
- **Cross-package import:** the shared-predicate option (Task 2 preferred) imports Medusa-app code from `services/log-ingestion`. The existing `body-features.check.ts` import shows this works, but confirm the build/tsconfig is happy; if not, fall back to the property-test floor.
- **Regeneration is required** for benefits to appear — the code change alone doesn't refresh existing on-disk goldens.
