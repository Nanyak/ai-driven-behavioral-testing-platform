# Resolver-agent repair

Agent escalation for the script-generator. When a deterministically-emitted spec
**fails to reproduce its mined `status_signature`** against the live SUT, an LLM
agent repairs the spec's *arrange/setup* so the precondition holds — under a hard
guardrail that it may never touch the assertion/oracle.

## Why

Deterministic resolvers in `resolve.ts` **select** a pre-existing entity (e.g.
`orders[0]`) and hope it's in the right state. The mined status was produced
against an entity the traffic generator **created** in a precise state (e.g. a
fresh *unfulfilled* order for cancel). Selection can't guarantee state, so
state-sensitive flows drift (mined `200` → live `400`). The arrange knowledge is
not in the mined data (the source session lacks the create steps and masks ids),
so reproducing it requires reasoning from the live error against the OAS — a fit
for an agent, not another hand-written `case`.

`resolve.ts` stays the fast first pass; the agent only handles what it can't.
`resolve.ts` becomes a performance cache of proven patterns, not a correctness gate.

## Flow

```
deterministic emit → verify each spec vs status_signature
                       ├─ reproduces → keep (cheap path)
                       └─ mismatch   → agent repair → oracle-guard → re-verify
                                        (loop ≤ N; green → keep, else revert)
```

- `verify.ts` — run one spec via the test-runner; `test.status === "passed"` is the
  oracle (every step asserts its own expected status inline).
- `oracle-guard.ts` — fingerprint the immutable lines (headers, test title,
  behavioral step titles + `.toBe(expected)` assertions) and reject any agent
  output that alters them. **This is what prevents green-washing.**
- `repair-task.ts` — bundle the live expected-vs-actual + response bodies + OAS
  slices into the agent prompt.
- `agent.ts` — headless `claude` CLI (tools disabled, single turn → pure text).
  Swap in `@anthropic-ai/sdk` for CI by implementing the `RepairAgent` interface.
- `repair.ts` — the loop + `reports/resolver-repair.json`.

## Usage

Off by default. Requires the SUT up (it runs specs live).

```
npm run script-generator:repair                 # repair all mismatching flows
npm run script-generator:repair -- --only <hash> # scope to one spec (demo)
# or: RESOLVER_AGENT=1 npm run script-generator:generate
```

Approved/blessed flows are skipped — their oracle is the source of truth.

## Scope discipline

This is **baseline establishment**, run against a known-good SUT. It is NOT a
"keep tests green" autopilot: a red in an ordinary later run is a *regression
signal*, not a repair trigger. Only the deterministic-generation phase escalates.

## Residual risk

`oracle-guard` is text-based. It catches the realistic cheats (changing an expected
status, dropping a step, changing the signature, adding `test.skip`/`test.fixme`).
A determined agent could still try to swallow an assertion via `try/catch` without
changing the assertion text; the re-verify backstop (a genuine pass is required)
makes that a poor strategy, but an AST-level guard would close it fully. Left as a
follow-up.

## Follow-up: promotion

When an agent repair for a pattern recurs, distil it into a deterministic
`resolve.ts` case so future flows of that shape skip the agent (cheap + stable).
Manual/optional today; could itself be agent-assisted.
