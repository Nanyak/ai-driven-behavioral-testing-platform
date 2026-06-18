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
   - Emit a **production-shaped hybrid log** (see note below): ISO `timestamp`, log `level`, logical `service`, `environment`, `request_id`, semantic `event`, HTTP `method`, normalized `endpoint`, `status`, and `duration_ms`. No raw bodies, headers, query params, or IPs are logged by default — production logs are lean and PII-free.
   - Read or generate `trace_id`.
   - Parse W3C `traceparent` when present instead of storing the whole header as the trace ID.
   - Read `session_id` from headers or cookies.
   - **Do not read or log a `persona` field.** Persona is intentionally *not* assigned at the logging layer — it is derived later as an emergent flow attribute in Phase 7 (plan §10.3 and the `persona-classification` memory). Logging a persona here would reintroduce the circularity the design avoids.
   - Capture `user_role` from the JWT `actor_type` (`customer`, `admin`, or `null` for unauthenticated guests). This is the JWT-derived signal and doubles as the held-out ground truth for Phase 7 validation.
   - Capture user/customer/admin ID when the authentication context exposes it.

3. Capture response context.
   - Wrap `res.json` and `res.send` to capture the returned body without changing the response.
   - Capture response status code and duration in milliseconds.
   - Capture response size when available.
   - Disable request and response body logging by default in production-style logs.
   - Allow body logging only when `LOG_CAPTURE_BODIES=true`, still with redaction and reduction.
   - **Body capture is enrichment, not a hard requirement (ADR 0001).** The golden **assertion oracle is the OpenAPI spec** (Phase 8), which is PII-free and needs no logged bodies — so production can run **bodies-off** and still produce a valid oracle. Bodies remain useful for two things: realistic **sample request payloads** in generated tests (Phase 9 reuses `request_payload`) and **tightening** under-specified spec schemas against real responses (the observed half of Phase 8's intersection). To keep the pipeline's source realistic, we run **bodies-off** by default (`LOG_CAPTURE_BODIES=false`, `LOG_ENVIRONMENT=production`) — this is what real production logging looks like. Bodies remain an **opt-in dev enrichment** (`LOG_CAPTURE_BODIES=true`) when richer payloads or tighter schemas are wanted, and are safe to enable because traffic runs against synthetic data with a mock payment provider (no real PII/PCI). The masking + reduction below is what keeps body capture production-safe when it is enabled.

4. Protect sensitive values.
   - Recursively mask passwords, tokens, secrets, cookies, authorization values, API keys, sessions, phone numbers, emails, addresses, PAN/card/payment fields, account IDs, and similar fields.
   - Mask sensitive headers and preserve only safe operational headers such as content type, user agent, accept language, and content length.
   - Apply the plan §7.1 reduction rules so Elasticsearch stays light: truncate each logged `response_body`/`request_payload` to a maximum of 8 KB; for large arrays log only the first element plus an array-length count; for endpoints known to return large catalogs (e.g. `GET /store/products`) store a schema snapshot instead of full content.
   - Record whether bodies were captured or disabled so ingestion can distinguish missing data from intentionally omitted data.

5. Emit JSON lines.
   - Write each event as a single JSON object per line.
   - Emit to stdout.
   - Append to `LOG_OUTPUT_PATH`, resolved from the repository root when the path is relative.

6. Make verification repeatable.
   - Add `npm run check:phase2`.
   - Verify the middleware file, required fields, masking rules, JSONL output behavior, and log path configuration.

## Production log shape (hybrid)

The middleware simulates **production logs** rather than dev access logs: a logical
`service` (a bounded context derived from the route — the app is a monolith, but
logs read like a service estate), a semantic `event` (`cart_item_added`,
`checkout_completed`, …) derived from `method` + normalized `endpoint`, and the
route itself so downstream sequence mining keeps working. Bodies are off.

```json
{
  "timestamp": "2026-06-13T08:43:02.881Z",
  "level": "INFO",
  "service": "cart-service",
  "environment": "production",
  "request_id": "f1e2d3c4-...",
  "trace_id": "a1b2c3d4-...",
  "session_id": "sess-guest-...",
  "user_id": null,
  "user_role": null,
  "event": "cart_item_added",
  "method": "POST",
  "endpoint": "/store/carts/{id}/line-items",
  "status": 200,
  "duration_ms": 45,
  "source": "medusa"
}
```

`user_role` is still the JWT-derived ground truth (`customer` / `admin` / `null`);
`event` + `endpoint` carry the behavioral signal Phase 6/7 mine. Field renames vs.
the original draft: `response_code` → `status`, `normalized_endpoint` → `endpoint`;
removed `raw_endpoint`, `query_params`, `request_headers`, `remote_ip`, `user_agent`,
`event_type`. `request_payload` / `response_body` appear only with
`LOG_CAPTURE_BODIES=true`.

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
- Logs include `event`, `level`, `timestamp`, `service`, `environment`, `request_id`, `method`, the normalized `endpoint` template, `status`, and `duration_ms`. The production-shaped log deliberately does **not** emit raw endpoint, query parameters, request headers, response size, remote IP, or user agent — see `apps/medusa/apps/backend/src/api/middlewares.ts`.
- Logs include trace, session, `user_role`, and actor identity fields when available. Persona is intentionally **not** logged or read from headers — it is derived later as an emergent flow attribute in Phase 7 (plan §10.3).
- Sensitive request and response values are masked.
- Request and response bodies are disabled by default and can be enabled with `LOG_CAPTURE_BODIES=true`. Bodies are enrichment only — the golden oracle is the OpenAPI spec (ADR 0001), so the pipeline still functions with bodies off.
- The `requireCustomerAuth` gate's `401` contract is **not** in Medusa's generated OAS (generators read routes/validators, not middleware). Its matchers/methods/error envelope are exported from a shared gate-config module that both this middleware (to enforce) and the Phase 8 overlay builder (to document) import, so the augmented spec covers the gate (ADR 0004).
- Logs are emitted as JSON lines to stdout and a log file.
- Phase 2 verification passes.
