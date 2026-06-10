# Phase 2 Implementation Plan

## Goal

Add structured Medusa request logging so API traffic can be mined later for persona behavior, session flows, generated tests, and regression reports while keeping production logs safe by default.

## Current Baseline

- Medusa backend exists under `apps/medusa/apps/backend`.
- Medusa v2 supports API middleware through `src/api/middlewares.ts`.
- Root `.env.example` defines `LOG_OUTPUT_PATH=./logs/medusa-json.log`.
- `mobile-app-login-success.log` is the observability-depth reference: it shows trace correlation, request/response boundaries, downstream latency, headers, parameters, and business-flow breadcrumbs. The Medusa implementation should borrow its correlation and latency model, but not its raw PII/body exposure.
- The repository already uses repeatable phase verification scripts under `scripts/`.

## Implementation Steps

1. Add a global Medusa request logging middleware.
   - Register middleware in `apps/medusa/apps/backend/src/api/middlewares.ts`.
   - Match all API routes so Store, Admin, Auth, and custom endpoints are logged.

2. Capture request context.
   - Capture ISO request timestamp, log level, event type, HTTP method, raw endpoint, normalized endpoint, query parameters, selected headers, remote IP, user agent, content length, and request payload status.
   - Read or generate `trace_id`.
   - Parse W3C `traceparent` when present instead of storing the whole header as the trace ID.
   - Read `session_id` from headers or cookies.
   - Read `persona` from custom persona headers.
   - Capture user role and user/customer/admin ID when authentication context exposes them.

3. Capture response context.
   - Wrap `res.json` and `res.send` to capture the returned body without changing the response.
   - Capture response status code and duration in milliseconds.
   - Capture response size when available.
   - Disable request and response body logging by default in production-style logs.
   - Allow body logging only when `LOG_CAPTURE_BODIES=true`, still with redaction and reduction.

4. Protect sensitive values.
   - Recursively mask passwords, tokens, secrets, cookies, authorization values, API keys, sessions, phone numbers, emails, addresses, PAN/card/payment fields, account IDs, and similar fields.
   - Mask sensitive headers and preserve only safe operational headers such as content type, user agent, accept language, and content length.
   - Limit large strings, arrays, objects, and deep response structures.
   - Record whether bodies were captured or disabled so ingestion can distinguish missing data from intentionally omitted data.

5. Emit JSON lines.
   - Write each event as a single JSON object per line.
   - Emit to stdout.
   - Append to `LOG_OUTPUT_PATH`, resolved from the repository root when the path is relative.

6. Make verification repeatable.
   - Add `npm run check:phase2`.
   - Verify the middleware file, required fields, masking rules, JSONL output behavior, and log path configuration.

## Commands

```bash
npm run check:phase2
```

## Phase 2.1 Docker Compose Development

Phase 2.1 adds a Docker Compose development stack for running the current Medusa backend app with its local infrastructure dependencies. The stack includes Medusa, PostgreSQL 15, and Redis 7.

Start the stack from the repository root:

```bash
docker compose up -d --build
```

Stop the stack:

```bash
docker compose down
```

If the local Docker CLI does not expose the `docker compose` subcommand, use `docker-compose` with the same arguments. The root helper scripts use `docker-compose` for compatibility with this development environment.

The Medusa backend and admin app are available at:

```text
http://localhost:9000/app
```

The `medusa` service bind mounts `apps/medusa` for development, mounts the root `.env` over the container backend `.env` so service hostnames are used, keeps container dependencies in named Docker volumes, runs Medusa database setup and seed scripts before starting, and writes structured Medusa logs to the host `logs/` directory through `LOG_OUTPUT_PATH=/workspace/logs/medusa-json.log`.

## Acceptance Criteria

- Medusa has request logging middleware configured for API routes.
- Logs include event type, level, timestamp, method, raw endpoint, normalized endpoint, query parameters, selected headers, response code, response size, duration, remote IP, and user agent.
- Logs include trace, session, persona, role, and actor identity fields when available.
- Sensitive request and response values are masked.
- Request and response bodies are disabled by default and can be enabled with `LOG_CAPTURE_BODIES=true`.
- Logs are emitted as JSON lines to stdout and a log file.
- Phase 2 verification passes.
