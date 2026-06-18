# Phase 15 — HITL Review Dashboard

## Goal

Add a **read-only Human-in-the-Loop (HITL) review view** to the platform dashboard
so an operator can browse discovered flows and their generated tests, see why each
was produced (provenance), and mark each test **approved** or **discarded**. The
decision is persisted to a lightweight JSON store keyed by flow signature, which the
Phase 7 cross-run skip gate (`coverage.ts`, ADR 0002) already reads — so a discarded
flow never re-surfaces and an approved one is not re-named/re-emitted next run.

This is an **MVP deliverable** (plan §16, §17). Step editing and execution gating are
explicit stretch goals, not MVP.

> Persona is **not** a control here. It is the read-only emergent label carried over
> from Phase 7 (plan §10.3); the reviewer only groups/filters by it and never sets
> it. Setting persona by hand would collapse the emergent-discovery claim.

## Location

```
apps/platform-dashboard/         # existing Vite + React app, port 5173
  src/
    review/
      ReviewView.tsx             # list + filter + detail + approve/discard
      useFlows.ts                # load candidates + generated tests + decisions
      decisions.ts              # read/write the HITL approval store (via API)
  server/                        # tiny read/write endpoint for the JSON store
data/
  hitl/
    approvals.json               # the approval/discard store (repo-root, clean-checkout safe)
```

## Data sources (all already produced by earlier phases)

- **Discovered flows + ranking** ← `services/behavior-engine/data/candidates/` (Phase 7): steps, support count, emergent persona, golden assertions, flow signature.
- **Generated tests** ← `generated-tests/**/*.spec.ts` (Phase 9): each stamps its `flow-signature` (ADR 0002), so a test maps back to its candidate.
- **Provenance** ← candidate carries source `session_id` / `trace_id` and support count; the validation report (`data/validation/classification-report-*.json`) supplies persona precision/recall context.

## The approval store (contract — already consumed by `coverage.ts`)

Path: **`data/hitl/approvals.json`** (repo root). The Phase 7 reader
(`behavior-engine/src/coverage.ts`) accepts **either** a top-level array **or**
`{ "entries": [ ... ] }`, and reads two fields per entry:

```jsonc
{
  "entries": [
    {
      "flow_signature": "<canonical signature from Phase 7/9>",  // or "signature"
      "status": "approved",                                       // "approved" | "discarded"
      "test_path": "generated-tests/customer/ab12cd.spec.ts",     // provenance (optional)
      "decided_by": "operator",                                   // optional
      "decided_at": "2026-06-18T00:00:00Z"                         // optional
    }
  ]
}
```

- Only `flow_signature` (or `signature`) and `status` are load-bearing; signatures are matched case-insensitively. Both `approved` **and** `discarded` feed the skip gate (a human-rejected flow must not come back).
- A **missing or malformed** store is treated as empty, never fatal (PO-6 / BA-F8) — so a clean checkout and a partially-written file both degrade gracefully. Do not change this tolerance.

## Implementation steps

1. **Review list.** Render one row per discovered flow: emergent persona, human name (Phase 7), support count, step count, # golden assertions, current decision (none/approved/discarded), linked `.spec.ts` path.
2. **Group & filter by persona** (`guest_shopper` / `registered_customer` / `admin_operator`, plus a `has_errors` overlay filter) — read-only label, never an input.
3. **Detail panel.** On select, show the full step sequence, the golden-schema assertions, and provenance (source `session_id` / `trace_id`, support count).
4. **Approve / discard.** Two actions per flow; writing an entry (with the flow signature) to `data/hitl/approvals.json` through the dashboard's small server endpoint. Re-deciding updates the existing entry (keyed by signature), never appends a duplicate.
5. **Reflect the skip gate.** Show which flows are already covered (have a test and/or a decision) so the reviewer sees what the next `behavior:mine` run will skip — mirrors the `skipped_existing` count in the Phase 7 run summary.

## Key decisions

- **Read-only MVP.** No step/assertion editing, no execution gating in the MVP. Both are listed as optional stretch goals only.
- **Persona is a derived label, never a control** (plan §10.3).
- **Signature-keyed store, shared with Phase 7** (ADR 0002) — the dashboard and the behavior engine agree on the flow signature as the join key; the store is the one place a human decision crosses back into the pipeline.
- **Graceful absence** — the whole feature is additive; with no store and no dashboard the pipeline still runs (Phase 7 manifest is simply empty).

## Validation / acceptance

- A reviewer can browse discovered flows and generated tests in the dashboard, filter by persona, and see provenance (source session/trace, support count, golden assertions).
- Each test can be marked approved or discarded; the decision persists to `data/hitl/approvals.json` in the shape `coverage.ts` parses.
- A discarded flow does **not** re-surface on the next `npm run behavior:mine` (its signature is in the skip manifest); an approved flow is not re-named/re-emitted.
- Re-deciding a flow updates its entry in place (no duplicate signatures).
- A missing/empty store yields an empty Phase 7 manifest without error (clean-checkout safe).
