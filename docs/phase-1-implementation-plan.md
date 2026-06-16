# Phase 1 Implementation Plan

## Goal

Initialize Medusa as the backend system under test and prove that Store and Admin REST APIs work against seeded local data.

## Current Baseline

- Medusa DTC starter exists under `apps/medusa`.
- Backend package exists under `apps/medusa/apps/backend`.
- The installed Medusa version is `2.15.5`.
- The generated seed script already creates products, regions, currencies, stock location, shipping options, mock/manual fulfillment, system default payment, inventory, sales channel, and a publishable API key.

## Implementation Steps

1. Configure Medusa runtime dependencies.
   - Keep `DATABASE_URL` in `apps/medusa/apps/backend/.env`.
   - Add `redisUrl: process.env.REDIS_URL` to `medusa-config.ts`.
   - Provide `npm run medusa:deps` to start local PostgreSQL and Redis containers when the ports are not already available.

2. Make setup commands reproducible from the repository root.
   - Add `npm run medusa:setup` for dependency startup, backend env sync, database setup, migration scripts, admin user creation, and publishable API key retrieval.
   - Add `npm run medusa:dev` and `npm run medusa:start` wrappers around the local Medusa CLI.
   - Add `npm run check:phase1` for repeatable verification.

3. Seed and configure commerce data.
   - Run Medusa migrations through `db:setup`.
   - Run migration scripts through `db:migrate:scripts`.
   - Use the existing `initial-data-seed.ts` script for products, regions, currency, shipping option, fulfillment, payment provider, inventory, sales channel, and publishable API key.
   - Prices use **decimal major units** (Medusa v2 convention): `amount: 15` means $15.00, not 15 cents. Do not seed cents and do not divide by 100 when rendering. `normalize-price-units.ts` is a one-off fix that converted legacy cents-style rows in an existing DB.

4. Configure access.
   - Create the admin user from `MEDUSA_ADMIN_EMAIL` and `MEDUSA_ADMIN_PASSWORD`.
   - Retrieve the publishable API key from PostgreSQL and write it to root `.env`.

5. Verify API availability.
   - Start Medusa locally on `MEDUSA_BACKEND_URL`.
   - Verify `/health` or basic backend availability.
   - Verify `GET /store/products` with `x-publishable-api-key`.
   - Verify Admin authentication through `POST /auth/user/emailpass`.
   - Verify Admin API access through `GET /admin/products`.

## Commands

```bash
npm run medusa:deps
npm run medusa:setup
npm run medusa:dev
npm run check:phase1
```

## Acceptance Criteria

- PostgreSQL is reachable on the configured database port.
- Redis is reachable on the configured Redis port.
- Medusa database migrations are applied.
- Seed data exists for products, regions, shipping options, and a publishable API key.
- Admin user authentication succeeds.
- Store products can be listed through the Store API.
- Admin products can be listed through the Admin API.
