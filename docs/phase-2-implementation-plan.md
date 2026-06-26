# Phase 2 Implementation Plan: Structured Logging

Phase 2 establishes the production-shaped request log contract that feeds ELK and
the downstream behavioral pipeline.

## Scope

- Emit one structured JSON line per Medusa request.
- Include route, method, status, trace/session identity, logical service, semantic
  event, duration, environment, and observed auth context.
- Keep request and response bodies off by default.
- When body capture is explicitly enabled, reduce payload size and mask sensitive
  fields unless a local synthetic fixture run opts into raw bodies.
- Preserve the OpenAPI/golden oracle boundary: logged bodies may enrich mining and
  generation, but they are not the pass/fail oracle by themselves.

## Acceptance

- `npm run check:phase2` passes.
- Bodies are controlled by `LOG_CAPTURE_BODIES`.
- Raw bodies require the separate `LOG_CAPTURE_RAW_BODIES` opt-in and must remain
  disabled for shared or production-shaped runs.
- Logging failures are isolated from request handling.
