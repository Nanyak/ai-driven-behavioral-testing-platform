# Phase 10 — Test Execution

## Goal

Run the generated Playwright tests against a running Medusa instance, capture machine-readable and human-readable results, and make persona-scoped runs easy (so a regression can be attributed to guest vs. customer vs. admin).

## Location

```
services/test-runner/
  src/
    run.ts               # wraps playwright test, selects projects/folders
    collect.ts           # parse Playwright JSON -> normalized run result
    cli.ts               # subcommands: all / guest / customer / admin / edge
  package.json
generated-tests/
  playwright.config.ts   # defines projects per persona folder
reports/
  playwright/            # raw Playwright HTML + JSON output
```

## Implementation steps

1. **Playwright projects.** In `playwright.config.ts`, define one project per persona folder (`guest`, `customer`, `admin`, `edge`) so they can be run independently via `--project`.
2. **Runner wrapper (`run.ts`).** Shell out to `playwright test` with the chosen project(s); pass base URL and credentials via env; force JSON + HTML reporters.
3. **CLI subcommands:**
   - `npm run test:all`
   - `npm run test:guest`
   - `npm run test:customer`
   - `npm run test:admin`
   - `npm run test:edge`
4. **Collect (`collect.ts`).** Parse Playwright's JSON reporter output into a normalized structure keyed by persona → flow → step, capturing expected vs. actual status, golden diff (surfaced from the imported Phase 8 comparator via test annotations/attachments), duration, and the source `session_id`/`trace_id` carried in the test metadata. This normalized object is the input to Phase 11 reporting.
5. **Failure clarity.** Ensure assertion failures print expected vs. actual status and a readable golden diff, not a raw object dump.

## Carrying provenance into results

Each generated test embeds the originating `flow_name`, `persona`, `source_sessions`, and a representative `trace_id` (as Playwright `test.info().annotations`). `collect.ts` lifts these into the run result so the Phase 11 report can cite where each test came from.

## Key decisions

- **Persona = Playwright project** → trivial scoped runs and per-persona pass/fail counts.
- **JSON is the contract** between execution and reporting; HTML is for humans.
- **Provenance travels with the test**, not reconstructed later.

## Validation / acceptance

- `npm run test:all` executes the generated suite against local Medusa.
- Per-persona subcommands run only their folder.
- Playwright JSON and HTML outputs land under `reports/playwright/`.
- A deliberately failing assertion is reported clearly (expected vs. actual).
- Normalized run result includes persona, flow, endpoint, expected/actual status, golden diff, duration, and source session/trace IDs.
