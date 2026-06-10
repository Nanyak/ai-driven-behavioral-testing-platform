# AI-Driven Behavioral Testing Platform

This repository contains an AI-driven behavioral regression testing platform for Medusa REST APIs.

The current verified baseline covers:

- Phase 0: project setup
- Phase 1: Medusa initialization, seed data, Store API, and Admin API
- Phase 2: structured JSONL request logging
- Phase 3: simple storefront and platform dashboard frontends

## Requirements

Install these before setup:

| Tool | Version | Purpose |
| --- | --- | --- |
| Node.js | 20 or newer | Medusa, TypeScript, verification scripts |
| npm | 10 or newer | Package management |
| Docker | Current stable | PostgreSQL, Redis, Medusa local stack |
| Docker Compose | `docker-compose` command available | Local multi-service startup |

## First-Time Setup

From the repository root:

```bash
npm install
```

Install the Medusa workspace dependencies:

```bash
npm install --prefix apps/medusa
```

Install the frontend app dependencies:

```bash
npm install --prefix apps/storefront
npm install --prefix apps/platform-dashboard
```

Create your environment file:

```bash
copy .env.example .env
```

The root `.env` is used by Docker Compose. For the Compose stack, keep these service-host URLs:

```env
DATABASE_URL=postgres://medusa:medusa@postgres:5432/medusa
REDIS_URL=redis://redis:6379
```

The setup script also writes a backend-local `.env` under `apps/medusa/apps/backend/.env` for host-side Medusa CLI commands.

## Start The Local Stack

Start PostgreSQL, Redis, and Medusa:

```bash
npm run compose:up
```

Watch Medusa logs:

```bash
npm run compose:logs
```

Stop the stack:

```bash
npm run compose:down
```

## Initialize And Seed Medusa

Run the Phase 1 setup script:

```bash
npm run medusa:setup
```

This will:

- start/check PostgreSQL and Redis
- run Medusa database setup
- run migration scripts
- seed products, regions, shipping options, stock, inventory, and API keys
- create the admin user
- write `MEDUSA_PUBLISHABLE_API_KEY` into `.env`

After setup, restart Medusa so the running container picks up the repaired schema and seed state:

```bash
docker-compose restart medusa
```

## URLs

| URL | Purpose |
| --- | --- |
| `http://localhost:9000/health` | Medusa health check |
| `http://localhost:9000/app` | Medusa Admin UI frontend |
| `http://localhost:9000/store/products` | Store API endpoint |
| `http://localhost:9000/admin/products` | Admin API endpoint |
| `http://localhost:8000` | Phase 3 storefront |
| `http://localhost:5173` | Phase 3 platform dashboard |

`/app` is the browser UI. Open it in your browser and log in with:

```text
Email: admin@example.com
Password: change-me
```

`/admin` is the Admin REST API. It returns JSON and requires a bearer token.

`/store` is the Store REST API. It requires a publishable API key header.

## API Examples

Store API calls need `x-publishable-api-key`:

```powershell
Invoke-RestMethod `
  -Uri "http://localhost:9000/store/products" `
  -Headers @{ "x-publishable-api-key" = $env:MEDUSA_PUBLISHABLE_API_KEY }
```

If your shell has not loaded `.env`, copy the value from `.env` directly:

```powershell
Invoke-RestMethod `
  -Uri "http://localhost:9000/store/products" `
  -Headers @{ "x-publishable-api-key" = "pk_your_key_here" }
```

Admin API calls need an auth token:

```powershell
$auth = Invoke-RestMethod `
  -Uri "http://localhost:9000/auth/user/emailpass" `
  -Method POST `
  -ContentType "application/json" `
  -Body '{"email":"admin@example.com","password":"change-me"}'

Invoke-RestMethod `
  -Uri "http://localhost:9000/admin/products" `
  -Headers @{ Authorization = "Bearer $($auth.token)" }
```

Opening `/store/...` or `/admin/...` directly in a browser address bar does not send these headers, so unauthorized responses are expected.

## Structured Logs

Phase 2 writes structured Medusa request logs to:

```text
logs/medusa-json.log
```

Each line is JSON. These logs are the input for later sequence mining phases.

Useful fields include:

- `timestamp`
- `trace_id`
- `session_id`
- `persona`
- `method`
- `raw_endpoint`
- `normalized_endpoint`
- `query_params`
- `response_code`
- `duration_ms`
- `request_payload`
- `response_body`

For sequence mining, send traffic with headers like:

```http
x-session-id: guest-session-001
x-persona: guest_shopper
```

Then group log events by `session_id`, sort by `timestamp`, and mine ordered `normalized_endpoint` sequences.

## Frontend Apps

Start the storefront:

```bash
npm run storefront:dev
```

Start the platform dashboard:

```bash
npm run dashboard:dev
```

Both apps use Vite dev-server proxies for `/medusa/*`, so browser requests are forwarded to `MEDUSA_BACKEND_URL` from the root `.env`.

The storefront supports product browsing, customer register/login, cart checks, and a Medusa checkout flow using the local system payment provider.

## Verification

Run all currently verified phases:

```bash
npm run check:phase0
npm run check:phase1
npm run check:phase2
npm run check:phase3
```

Expected result:

```text
Phase 0 verification passed.
Phase 1 verification passed.
Phase 2 verification passed.
Phase 3 verification passed.
```

You can also verify the TypeScript Medusa backend:

```bash
cd apps/medusa/apps/backend
npx tsc --noEmit
```

Or run the Medusa build:

```bash
npm --prefix apps/medusa run backend:build
```

## Current Project Layout

```text
apps/
  medusa/
    apps/backend/
      src/api/
      src/migration-scripts/
  platform-dashboard/
  storefront/
docs/
generated-tests/
golden-responses/
infra/
logs/
reports/
scripts/
services/
```

## Troubleshooting

If Store API returns `Publishable API key required`, add the `x-publishable-api-key` header.

If Admin API returns `Unauthorized`, log in through `/auth/user/emailpass` and send `Authorization: Bearer <token>`.

If Phase 1 fails because API calls cannot connect, check that Medusa is healthy:

```bash
docker-compose ps
```

Then restart Medusa:

```bash
docker-compose restart medusa
```

If the database is empty or missing tables, run:

```bash
npm run medusa:setup
docker-compose restart medusa
```
