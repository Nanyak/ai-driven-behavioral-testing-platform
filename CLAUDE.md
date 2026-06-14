# CLAUDE.md — Project Instructions

## 1. Before writing any code

**Always read the relevant spec files first.** This is a phased project — every
subsystem has a written plan. Do not infer intent from code alone when a spec exists.

| Location | Contents |
| -------- | -------- |
| `context/plan.md` | Overall architecture and MVP scope |
| `context/checklist.md` | Phase completion status — check before assuming a phase is done |
| `context/problem-statement.md` | Why this project exists |
| `docs/phase-N-implementation-plan.md` | Detailed plan for each phase (0–14) |
| `docs/adr/` | Architecture Decision Records — binding decisions that override intuition |
| `docs/local-development.md` | How to start the full stack locally |

When a task touches a phase or subsystem, read its plan file. When a task
involves a cross-cutting concern (log schema, auth, personas), check `context/`
and `docs/adr/` too.

## 2. After writing code

**Always update documentation in the same session as the code change.**

- If you add, remove, or rename a flow / session type / action: update the
  service README and the relevant phase plan.
- If you change a log field, endpoint shape, or schema: update `context/` files
  that document that schema.
- If you make a decision that should constrain future work: write or update an
  ADR in `docs/adr/`.
- "I'll document it later" is not acceptable — the spec is how future sessions
  (and future you) know what the code is supposed to do.

## 3. Verification commands

Run the appropriate check script after any non-trivial change to confirm the
phase still passes end-to-end:

```bash
npm run check:phase0   # project setup
npm run check:phase1   # Medusa API reachability + seed data
npm run check:phase2   # structured logging middleware
npm run check:phase3   # Elasticsearch ingestion
npm run check:phase4   # log schema + Kibana
npm run check:phase5   # traffic generator acceptance gates

# Traffic generator TypeScript must always compile clean:
cd services/traffic-generator && npx tsc --noEmit
```

For the traffic generator specifically, a clean TypeScript compile is a hard
gate — do not report work as done if `tsc --noEmit` has errors.

## 4. Monorepo layout

```
apps/
  medusa/          Medusa backend (system under test)
  storefront/      Next.js customer-facing storefront
  platform-dashboard/  Internal ops dashboard
services/
  traffic-generator/   Synthetic traffic (Phase 5) — TypeScript, Node
  log-ingestion/       Elasticsearch ingestion service (Phase 3)
  behavior-engine/     Behavioral modeling (Phase 7)
  script-generator/    Playwright test generation (Phase 9)
  test-runner/         Test execution + reporting (Phase 11)
context/             Project-level specs and checklists
docs/                Phase plans + ADRs
scripts/             Root-level automation (check-phaseN, setup)
infra/               Docker / ELK / infra config
```

When you need to understand a service, read its own README before the source.

## 5. Coding standards

### General
- **No hardcoded runtime IDs.** Product IDs, order IDs, region IDs, variant IDs
  must always be resolved from the live backend at runtime. Never paste an ID
  from a test run into source code.
- **No dead code.** Remove code you are replacing. Do not leave old logic
  commented out or shadowed by a renamed variable.
- **No speculative abstractions.** Add only what the current task requires.
  Three similar cases is not yet a reason to abstract.
- **No error handling for impossible cases.** Trust framework guarantees.
  Only validate at system boundaries (user input, external API responses).

### Traffic generator (`services/traffic-generator/`)
- **No persona headers.** Role is established by which auth endpoints a session
  hits. The Medusa logging middleware reads `actor_type` from the JWT. Persona
  is a Phase 7 output, never a Phase 5 input.
- **No scripting the holdout.** The `register → login → checkout` sequence lives
  exclusively in `personas/customer-llm.ts`. Flow files in `flows/` must never
  emit both `register` and `complete_checkout` in the same session.
- **Token reuse is probabilistic, not guaranteed.** `useExistingToken` should be
  called only when `account.token` is set AND `chance(p)` passes. Never assume
  a token is always present.
- **All new session types must be wired in full:** `SESSION_TYPES` array,
  `STAGE_OF` map, `Weights` interface, profile weight objects, `identityFor`
  switch, `IDENTITY_SPLIT` map, and `dispatch` switch. A missing entry in any
  one of these causes a silent drop or TypeScript error.

### Medusa / API
- **Medusa 2.x endpoint shapes vary by minor version.** Any call to
  `POST /store/returns`, `POST /admin/promotions`, or the fulfillment/refund
  sequence should degrade to a logged non-zero status rather than crashing.
  Mark version-sensitive calls with `// VERIFY against live backend`.
- **Use the publishable API key** (`x-publishable-api-key` header) for all
  Store API calls. Admin API calls use the JWT from `POST /auth/user/emailpass`.

### TypeScript
- Prefer `type` imports for interface-only imports.
- `async` functions that make no `await` calls should be synchronous.
- Do not use `any` for API response bodies without a comment explaining why.

## 6. Infrastructure awareness

The full stack runs via Docker Compose. Key services and their default ports:

| Service       | Port  | Start command          |
| ------------- | ----- | ---------------------- |
| Medusa        | 9000  | `npm run compose:up`   |
| Elasticsearch | 9200  | `npm run elk:up`       |
| Kibana        | 5601  | `npm run elk:up`       |
| Logstash      | 5044  | `npm run elk:up`       |
| PostgreSQL    | 5432  | `npm run medusa:deps`  |
| Redis         | 6379  | `npm run medusa:deps`  |

Do not assume any service is running. Use `npm run check:phaseN` or a direct
`/health` check to confirm reachability before debugging API failures.

## 7. Spec-to-task lookup

| Task area | Read first |
| --------- | ---------- |
| Traffic generator flows / session mix | `docs/phase-5-implementation-plan.md` + `services/traffic-generator/README.md` |
| Log schema / Elasticsearch field names | `docs/phase-2-implementation-plan.md` + `docs/phase-3-implementation-plan.md` |
| Persona classification logic | `docs/phase-7-implementation-plan.md` |
| Behavioral modeling / sequence mining | `docs/phase-7-implementation-plan.md` + `docs/phase-8-implementation-plan.md` |
| Playwright test generation | `docs/phase-9-implementation-plan.md` |
| Test execution + reporting | `docs/phase-11-implementation-plan.md` |
| Medusa API endpoints + seed data | `docs/phase-1-implementation-plan.md` |
| Storefront UI | `apps/storefront/` README |
| Assertion oracle design | `docs/adr/0001-assertion-oracle-openapi-contract.md` |
| Cross-run dedup / skip gate / flow signature | `docs/adr/0002-cross-run-flow-signature-skip-gate.md` |
| Overall architecture decisions | `docs/adr/` |

## 8. Hard constraints (never break these)

1. **Log bodies are off in production shape.** The logging middleware must not
   emit request or response bodies. The OpenAPI spec is the golden oracle
   (ADR 0001).
2. **`session_id` source tag is for debugging only.** The `sess-<source>-<uuid>`
   prefix must never be used as a classifier signal in Phase 7.
3. **Stage 2 hard-fails on an empty order pool.** Do not add fallbacks that
   silently skip post-purchase sessions when no orders exist — the hard exit
   in `run.ts` is intentional.
4. **Floors are minimums, not targets.** `applyFloors` tops up counts; it does
   not cap them. Do not treat floor values as the desired session count.
5. **The holdout is LLM-only.** `newCheckout` sessions must go through
   `personas/customer-llm.ts`. Never add a scripted fallback that bypasses it.
