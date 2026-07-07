# Mutation-Based Evaluation — Implementation Plan

**Status:** proposed
**Owner:** (assign)
**Supersedes:** the hard-coded fault catalog in `apps/medusa/apps/backend/src/api/regression-faults.ts` + the recreate-per-fault harness in `services/test-runner/src/eval/{catalog,backend}.ts`.

---

## 1. Goal & motivation

The current regression-evaluation seeds **4 hand-authored faults** into the Medusa SUT and measures whether the generated suite catches them. Two problems:

1. **Hard-coded.** The faults are a fixed list I chose to match assertions I knew existed. It cannot answer "which regressions would actually appear?" — it only tests the four I picked.
2. **SUT-coupled.** The injector lives inside Medusa middleware (`REGRESSION_DEMO`), so it only works for this one backend and requires editing the system under test.

**This plan replaces that with mutation testing:** mechanically generate a large population of behavioral **mutants** from the platform's own **golden responses**, apply each via a **fault-injection proxy** that sits in front of the SUT (SUT untouched), run the generated suite against each mutant, and report a **mutation score** (`killed / total`) plus the **survivors** — the exact `(endpoint, field-path, operator)` regressions no assertion catches. Survivors are actionable coverage gaps and can feed the existing invariant-proposer.

**Design invariants (do not violate):**
- The SUT is never modified. No code, no env flag, no redeploy. Mutation happens in a proxy the platform owns.
- Faults are **derived from goldens**, never hand-listed. Adding a new endpoint/field to the goldens automatically expands the mutant population.
- Mutation is **domain-agnostic**: the proxy mutates JSON responses generically; nothing is Medusa-specific.
- The evaluation is **honest**: a mutant the suite cannot observe **survives** and is reported as a gap. A clean-baseline requirement makes every kill attributable.

---

## 2. Architecture

```
                    set/clear active mutant (control channel)
        ┌───────────────────────────────────────────────┐
        │                                                │
  ┌─────┴──────┐        ┌──────────────────────┐        ┌▼──────────────┐
  │  mutation  │        │   generated suite     │  HTTP  │ fault-injection│  HTTP  ┌──────────┐
  │  harness   │──runs──▶ (Playwright, unchanged)│───────▶│     proxy      │───────▶│ real SUT │
  │ (eval CLI) │        └──────────────────────┘        └────────────────┘        │ (Medusa) │
  └─────┬──────┘                                          applies active mutant     └──────────┘
        │   reads goldens (blobs)                          to matching responses
        │
  ┌─────▼──────┐
  │  mutant    │  goldens/*.json ──▶ Mutant[]  (drop/retype/null/empty/value/status)
  │ generator  │
  └────────────┘
```

**Flow per evaluation run:**
1. **Generate** `Mutant[]` from goldens (offline, deterministic).
2. **Start** the fault-injection proxy (upstream = real SUT).
3. **Baseline**: proxy in passthrough, run the suite → must be green; capture the `endpoint → [spec files]` map for targeted runs.
4. **For each mutant**: `POST` it to the proxy control channel → run only the specs that touch its endpoint → detect net-new failure → `killed | survived`.
5. **Score & report**: mutation score, per-operator breakdown, survivors list. Publish to blob store; surface in the dashboard Evaluation tab.

---

## 3. Non-goals

- Code-level mutation (Stryker-style) of Medusa source — infeasible (it's a framework in `node_modules`).
- Mutating traffic/logs upstream of the SUT — we mutate **responses**, the layer the goldens assert on.
- Perfect equivalent-mutant detection — survivors that are genuinely unobservable are acceptable noise; we surface them, we don't prove killability.
- Running the full evaluation live on stage — it is a batch job; pre-generate and view the published report.

---

## 4. Component 1 — Mutant generator

**New:** `services/behavior-eval/src/mutants/` (new package `@platform/behavior-eval`, or a subdir of `services/test-runner` — see §11). Prefer a **new service** so the proxy + harness + generator share a home independent of the runner.

### 4.1 Input
Golden responses, read from the **blob store** (source of truth on the `remote` backend), key prefix `goldens/`, each a `GoldenResponse` (`services/golden/src/types.ts`):

```ts
interface GoldenResponse {
  endpoint: string;              // "POST /store/carts/{id}/complete"
  expected_status: number;
  expected_schema: SchemaNode;   // nested { field: type | "ignored" | {...} }
  ignore_fields: string[];       // dynamic fields — DO NOT mutate (false kills)
  value_rules: ValueRule[];      // enum/const/range/format constraints (high-signal)
  schema_source: "openapi" | "openapi+observed" | "observed";
  // ...
}
```
Read via `storage.blobs.list("goldens")` + `storage.blobs.get(key)` (`packages/storage`). Vendor or import `GoldenResponse`/`SchemaNode`/`ValueRule` types from `services/golden/src/types.ts`.

### 4.2 Mutation operators
Walk `expected_schema` to enumerate **field paths** (dotted, `[]` for array elements — same convention as `ValueRule.path` and `compare/compare.ts`). For each non-ignored path, emit type-appropriate mutants; for each `value_rule`, emit a rule-violating mutant.

| Operator | Applies to | Proxy effect | Expected killer (layer) |
|---|---|---|---|
| `drop_field` | any schema field | delete key at path | golden **schema** diff (missing) |
| `null_field` | non-nullable field | set to `null` | golden **schema** diff (type) |
| `retype_field` | any field | coerce type (number→string, object→null, array→`{}`) | golden **schema** diff (type) |
| `empty_array` | array field | replace with `[]` | schema/business invariant (e.g. `cart_has_items`) |
| `enum_violation` | `value_rule.kind==="enum"` | set to a value NOT in `values` | golden **value** diff |
| `const_violation` | `value_rule.kind==="const"` | set to a different value | golden **value** diff |
| `range_violation` | `value_rule.kind==="range"` | set below `min`/above `max` | golden **value** diff |
| `format_violation` | `value_rule.kind==="format"` | set a malformed string | golden **value** diff |
| `status_change` | the golden's `expected_status` | override HTTP status (e.g. 200→500, 201→200) | spec **status** assert + golden lookup |

### 4.3 Skip rules (avoid false kills / noise)
- **Skip any path in `ignore_fields`** and any path under a schema node typed `"ignored"`. These are dynamic (ids, timestamps, tokens); mutating them would false-kill.
- Skip paths matching `GLOBAL_IGNORE_FIELDS` / `PER_ENDPOINT_IGNORE_FIELDS` (`services/golden/src/ignore-fields.ts`, `ignoreFieldsFor(endpoint)`).
- For `observed`-only goldens, `value_rules` is empty — only schema/status operators apply.
- Cap per `(endpoint, status)` mutant count (`EVAL_MAX_MUTANTS_PER_GOLDEN`, default 12) and total (`EVAL_MAX_MUTANTS`, default 150), sampling deterministically (seeded) so runs are reproducible. Prioritize: value-rule mutants > business-ish fields (non-`_at`, non-`id`) > status > deep leaves.

### 4.4 Output — the `Mutant` contract (shared type)
```ts
export interface Mutant {
  id: string;                 // stable hash of the fields below (dedupe + reporting)
  endpoint: string;           // templated, matches GoldenResponse.endpoint ("POST /store/carts/{id}/complete")
  status: number;             // the golden's expected_status this mutant targets
  operator: MutationOperator; // see table
  path: string | null;        // dotted json-path; null for status_change
  param?: unknown;            // e.g. the out-of-enum value, the perturbed number, the new status
  origin_golden: string;      // blob key, for provenance
}
```
`generateMutants(goldens: GoldenResponse[], opts): Mutant[]` — **pure**, unit-testable, deterministic given a seed.

---

## 5. Component 2 — Fault-injection proxy

**New:** `services/behavior-eval/src/proxy/` — a zero-dependency Node HTTP reverse proxy (`node:http`, no framework).

### 5.1 Responsibilities
- Forward every request to the upstream SUT **transparently**: method, path, query, headers, body, and the response status/headers/body — byte-identical in passthrough mode.
- Hold **one active mutant** (or none) in memory.
- On a response whose `(method + normalizeEndpoint(path), status)` matches the active mutant's `(endpoint, status)`, and whose `content-type` is JSON, apply the mutation to the parsed body (or override status), re-serialize, and fix `content-length`. Non-JSON / non-matching responses pass through untouched.

### 5.2 Endpoint matching
Reuse **`normalizeEndpoint`** from `services/log-ingestion/src/pipeline.ts` (it already maps concrete segments → `{id}` with the same `{id}` token the goldens use). Match key = `` `${req.method} ${normalizeEndpoint(req.url)}` ``. **Import or vendor** `normalizeEndpoint` (extract it to a shared util if importing across packages is awkward — it is a pure function with no deps).

### 5.3 Control channel
Reserve a path prefix the proxy **intercepts and never forwards**: `/__eval/*`.
- `POST /__eval/mutant` — body `Mutant | null`; sets/clears the active mutant. Returns 200.
- `GET  /__eval/health` — proxy up + upstream reachable.
- `GET  /__eval/hits` — per-mutant application counter (did the mutant actually fire this run? used to distinguish "survived because untested" from "survived because never hit").

Guard: the control prefix is only active when `EVAL_PROXY_CONTROL=1` (default off), so a stray proxy can't be driven by arbitrary traffic.

### 5.4 Config
- `EVAL_PROXY_PORT` (default 9099)
- `EVAL_PROXY_UPSTREAM` (default `MEDUSA_BACKEND_URL` → real SUT)
- Bind to loopback only.

### 5.5 Correctness notes
- Apply mutation **only after** confirming the response matched — never touch unrelated responses (would corrupt shared SUT state observed by later steps).
- `retype_field`/`null_field` must not throw on absent paths (mutant may target a field a particular response instance omits) — apply best-effort, and record a "not applied" hit so the harness can treat a never-applied mutant as **inconclusive**, not survived.
- Preserve response headers except `content-length` (recomputed) and any `content-encoding` (buffer must be decoded or the proxy must request identity encoding upstream — send `accept-encoding: identity` to the SUT to keep bodies plain).

---

## 6. Component 3 — Mutation harness

**Extends** `services/test-runner/src/eval/` (reuse `runPlaywright`, `collectFromFile`, `NormalizedRunResult`). New module `services/behavior-eval/src/harness/` orchestrates; it may depend on `@platform/test-runner` exports (`runPlaywright`, `Target`, `selectedSpecPaths`, `collectFromFile`).

### 6.1 Point the suite at the proxy
Set `MEDUSA_BACKEND_URL=http://localhost:${EVAL_PROXY_PORT}` for the suite subprocess (via the existing `runEnv()` precedence — process.env wins). The proxy's upstream is the **real** SUT URL. **No container recreates** — `services/test-runner/src/eval/backend.ts` is deleted.

### 6.2 Baseline pass
1. Clear the active mutant (passthrough).
2. Run the suite (target configurable; default the approved suite — see storage note §13).
3. Assert baseline is green. If not, abort with the red specs (kills would be unattributable). Executability rate = passed/executed.
4. Build `endpointToSpecs: Map<endpoint, Set<specFile>>` from the normalized baseline steps (`NormalizedStep.endpoint` + `NormalizedTest.file`). Used for targeted runs.

### 6.3 Per-mutant loop
For each `Mutant`:
1. `POST /__eval/mutant` with the mutant.
2. Determine target specs = `endpointToSpecs.get(mutant.endpoint)`. If empty → mutant is **inconclusive** (no test exercises this endpoint; distinct from survived). Skip execution, record reason.
3. Run **only those specs** (`runPlaywright({ target: <persona>, directSpecPaths })` — reuse the existing `directSpecPaths` admission bypass, or add a path-filtered run mode). This is the key performance lever: a mutant on `GET /store/orders/{id}` runs 1–2 specs, not the whole suite.
4. `collectFromFile` → check `GET /__eval/hits`:
   - mutant **applied ≥1 time** AND a net-new failure appears on `mutant.endpoint` (vs baseline; reuse the net-new logic in `detect.ts`, generalized to "any failed step on endpoint") → **killed** (record catching spec + assertion message).
   - applied ≥1 time, no net-new failure → **survived** (coverage gap).
   - **never applied** → **inconclusive** (endpoint not hit under the chosen specs / response shape didn't contain the path).
5. Clear the mutant.

### 6.4 Scoring
```ts
mutation_score = killed / (killed + survived)     // inconclusive excluded from denominator
```
Also: per-operator kill rate, per-endpoint kill rate, and the survivors list.

### 6.5 Performance
- Targeted runs (§6.3.3) dominate the win. With ~150 mutants averaging ~2 specs each and a warm SUT, target minutes, not hours.
- Optional: group mutants by endpoint and reuse the same spec subset back-to-back (locality).
- `workers: 1` stays (shared mutable SUT); do not parallelize suite runs against one proxy/SUT.

---

## 7. Component 4 — Metrics, report, dashboard

### 7.1 Metrics contract
```ts
interface MutationMetrics {
  generated_at: string;
  target: string;
  total_mutants: number;
  killed: number;
  survived: number;
  inconclusive: number;
  mutation_score: number;                 // killed / (killed + survived)
  executability_rate: number;
  baseline_clean: boolean;
  by_operator: Record<MutationOperator, { killed: number; survived: number }>;
  survivors: Array<{ endpoint: string; status: number; operator: string; path: string | null }>;
}
```

### 7.2 Publishing
Write `reports/eval/mutation-metrics.json` + `mutation-metrics.html` to disk **and** blob store (mirror the pattern already in `services/test-runner/src/eval/cli.ts`, which publishes to `reports/eval/*`). Keep the "latest overwrites" model (single key) unless run history is later needed.

### 7.3 Dashboard
Extend the existing **Evaluation** tab (`apps/platform-dashboard/src/evaluation/EvaluationView.tsx`, endpoint `/api/eval/view`, reader `readEvalMetricsHtml`/`readEvalMetricsSummary` in `server/hitl-store.ts`):
- KPI strip: **Mutation score**, killed/survived/inconclusive, executability.
- Embed `mutation-metrics.html`.
- New: a **survivors table** (endpoint, path, operator) — the actionable output. Consider a "propose invariant" affordance (§8).
- Point `readEvalMetricsSummary` at `mutation-metrics.json`.

---

## 8. Component 5 (optional / follow-up) — survivors → invariant proposer

Survivors are observed fields/behaviors with **no assertion**. Feed them into the existing structured-invariant proposer (`services/script-generator/src/invariants/propose.ts`): for each survivor, emit a candidate invariant proposal (schema-checked + live-verified as today) so the platform can *close* the gap it just measured. This closes the learn → test → measure → improve loop. Scope as a separate PR after §4–§7 land.

---

## 9. Migration — remove the hard-coded injector

Delete / revert (the proxy fully replaces it):
- `apps/medusa/apps/backend/src/api/regression-faults.ts` — **delete**.
- `apps/medusa/apps/backend/src/api/middlewares.ts` — **revert** the `regressionDemoFault` middleware + its route registration + the `activeRegressionFault`/`applyCompletionFault` import (restore SUT to untouched).
- `docker-compose.yml` — remove `REGRESSION_DEMO` from the `medusa` service env.
- `.env.example` — remove the `REGRESSION_DEMO` block.
- `services/test-runner/src/eval/{catalog,backend,detect,harness,metrics,cli}.ts` — **delete** (superseded by `@platform/behavior-eval`). Keep/port `detect.ts`'s net-new logic into the new harness.
- `scripts/check-phase12.mjs` — **revert** to reading only the disk-based baseline/red fixtures (drop the two-file middleware assertions), or delete if the mutation harness's own tests supersede it.
- Root `package.json` — replace `eval:regression`/`eval:test` scripts with the new package's `eval:mutate` / `eval:test`.

**Green→red demo flip** is preserved differently: arm any single named mutant via the proxy control channel (a thin `eval:mutate --only <mutant-id>` or a tiny curl to `/__eval/mutant`), so the live flip no longer requires a SUT restart.

---

## 10. Shared types (single source of truth)

Put in `services/behavior-eval/src/types.ts`: `MutationOperator`, `Mutant`, `MutationResult` (`{ mutant: Mutant; verdict: "killed"|"survived"|"inconclusive"; catching_spec?; evidence?; applied_count: number }`), `MutationMetrics`. The proxy control channel and the harness both import these; the proxy accepts a `Mutant` verbatim.

---

## 11. File-by-file work plan

New package `services/behavior-eval/` (`@platform/behavior-eval`, `type: module`, tsx + node:test, mirror `services/test-runner/package.json`):
```
src/
  types.ts                      # Mutant, MutationResult, MutationMetrics, MutationOperator
  golden-source.ts              # read GoldenResponse[] from blobs ("goldens/") ; import GoldenResponse type from services/golden
  mutants/
    generate.ts                 # generateMutants(goldens, opts) -> Mutant[]  (pure)
    generate.test.ts
    schema-walk.ts              # walk SchemaNode -> field paths (respect "ignored" + ignore_fields)
    operators.ts                # per-operator param synthesis (out-of-enum value, perturbed number, malformed format)
  proxy/
    proxy.ts                    # http reverse proxy + /__eval/* control + mutation application
    apply.ts                    # applyMutation(mutant, body|status) -> mutated  (pure, unit-tested)
    apply.test.ts
    endpoint.ts                 # normalizeEndpoint (import/vendor from log-ingestion) + match key
  harness/
    run.ts                      # baseline + per-mutant loop; imports @platform/test-runner runPlaywright/collectFromFile
    detect.ts                   # net-new-failure-on-endpoint (ported from test-runner eval/detect.ts)
    detect.test.ts
    endpoint-index.ts           # build endpoint -> [spec files] from baseline NormalizedRunResult
  metrics.ts                    # buildMetrics + renderConsole + renderHtml (survivors table)
  cli.ts                        # `eval:mutate` entrypoint: spawn proxy, generate, run, publish
package.json                    # scripts: eval:mutate, test
tsconfig.json
```
Root `package.json`: `"eval:mutate": "npm --prefix services/behavior-eval run eval --"`, `"eval:test": "npm --prefix services/behavior-eval run test"`.

Dashboard: edit `EvaluationView.tsx` (+ survivors table), `server/hitl-store.ts` (point summary at `mutation-metrics.json`; add survivors passthrough), no new endpoint needed (`/api/eval/view` already serves `reports/eval/*` — write `mutation-metrics.html` to a key it serves, or generalize the reader).

---

## 12. Testing

- **Unit (pure, node:test):**
  - `generate.test.ts`: given a fixture `GoldenResponse` (schema + value_rules + ignore_fields), asserts the expected mutant set — including that ignored/dynamic fields are skipped and value-rule mutants are emitted.
  - `apply.test.ts`: each operator transforms a sample body correctly; absent path → no-op + not-applied; non-JSON untouched; status override works.
  - `detect.test.ts`: port existing cases (net-new kill, pre-existing red not credited, different-endpoint not credited, never-applied → inconclusive).
- **Integration (against the live stack, gated):**
  - Start proxy → passthrough → suite green (proves transparent forwarding).
  - Arm a known drop-field mutant on the checkout golden → suite red on `POST /store/carts/{id}/complete` (proves end-to-end kill).
  - Arm a mutant on an unasserted field → survived (proves the harness reports gaps, not false kills).
- **Determinism:** same goldens + seed ⇒ identical `Mutant[]` (snapshot test).

---

## 13. Config & environment

- Harness storage: to evaluate the **approved** suite it must read the same store the dashboard approved into. On the `remote` backend the host must set `STORAGE_BACKEND=remote`, `MINIO_ENDPOINT=http://localhost:9100`, `MINIO_ROOT_USER/PASSWORD`, `S3_BUCKET=platwright`, `PLATFORM_DATABASE_URL=…@localhost:5433/…`. **Do not source the container `.env`** (it carries container hostnames `postgres`/`minio` unreachable from the host). Goldens read from blob prefix `goldens/`.
- Proxy: `EVAL_PROXY_PORT`, `EVAL_PROXY_UPSTREAM` (defaults to real `MEDUSA_BACKEND_URL`), `EVAL_PROXY_CONTROL=1`.
- Generator: `EVAL_MAX_MUTANTS`, `EVAL_MAX_MUTANTS_PER_GOLDEN`, `EVAL_MUTANT_SEED`.
- Runs on the **host** (spawns the suite subprocess; the proxy is a plain node process). No docker required — a clean improvement over the recreate model.

---

## 14. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **False kills** from mutating dynamic fields | Strict skip of `ignore_fields` + `"ignored"` schema nodes + `GLOBAL/PER_ENDPOINT_IGNORE_FIELDS`. |
| **Never-applied mutants** counted as survived | `/__eval/hits` counter → `inconclusive`, excluded from the score denominator. |
| **Shared SUT state** poisoned by a mutation bleeding into later steps | Mutate only the matched response; clear mutant between runs; targeted runs reduce blast radius. |
| **Compressed responses** hide the body | Proxy sends `accept-encoding: identity` upstream. |
| **Endpoint template mismatch** (proxy vs golden) | Reuse the exact `normalizeEndpoint` used by ingestion; snapshot-test match keys against real golden endpoints. |
| **Runtime blow-up** | Targeted per-endpoint runs + mutant caps + seeded sampling. |
| **Baseline flakiness** (e.g., admin return-lifecycle needing a fulfilled order) | Prefer a self-provisioning target (customer) or ensure seed state; abort on non-green baseline rather than mis-attributing. |

---

## 15. Milestones

1. **M1 — Generator + types** (`types.ts`, `golden-source.ts`, `mutants/*`, tests). Deliverable: `Mutant[]` from real goldens, deterministic. No SUT contact.
2. **M2 — Proxy** (`proxy/*`, `apply.ts`, tests). Deliverable: transparent passthrough (suite green through proxy) + single-mutant arm via `/__eval/mutant`.
3. **M3 — Harness + metrics + CLI** (`harness/*`, `metrics.ts`, `cli.ts`). Deliverable: `npm run eval:mutate` → mutation score + survivors report published to blobs.
4. **M4 — Dashboard** (survivors table + score KPI in Evaluation tab).
5. **M5 — Migration/removal** (§9): delete SUT injector + old eval, revert middleware, update scripts/checks.
6. **M6 (optional)** — survivors → invariant proposer (§8).

Land M1–M2 behind the existing hard-coded eval (both can coexist until M5), then cut over.

---

## 16. Acceptance criteria

- Zero mutation logic in the SUT (`apps/medusa`) — grep clean for `REGRESSION_DEMO` / `regression-faults`.
- `npm run eval:mutate` produces a `MutationMetrics` with `total_mutants` derived from live goldens (not a constant), a mutation score, and a non-empty survivors list on a suite with known gaps.
- Adding a new golden (new endpoint) increases `total_mutants` with no code change.
- The proxy passes the suite green in passthrough (transparent) and flips it red for a known drop-field mutant on an asserted field.
- Survivors correspond to real unasserted fields (spot-check ≥3).
```
