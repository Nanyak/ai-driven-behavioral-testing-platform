# Phase 3 Implementation Plan

## Goal

Provide two local frontend applications for the behavioral testing platform:

- A simple Storefront that exercises Medusa Store APIs from a browser.
- A Platform Dashboard that shows backend/API status and links to the local tools.

## Ports

| App | Port | URL |
| --- | --- | --- |
| Storefront | 8000 | `http://localhost:8000` |
| Platform Dashboard | 5173 | `http://localhost:5173` |
| Medusa Admin | 9000 | `http://localhost:9000/app` |

## Storefront Scope

1. Create `apps/storefront` as a Vite React application.
2. Read Medusa configuration from the root `.env` through Vite config defaults.
3. Proxy `/medusa/*` requests to `MEDUSA_BACKEND_URL` to avoid local CORS fragility.
4. Load seeded products with `GET /store/products`.
5. Provide a product detail view from the selected product.
6. Create a cart using the first available region.
7. Add a selected product variant to the cart.
8. Display cart item count and cart contents.
9. Provide customer account registration, login, profile check, and logout controls.
10. Provide a cart check that reports shipping options, payment providers, shipping methods, and payment sessions.
11. Provide a checkout action that updates cart address/email, adds shipping, initializes payment collection, creates a payment session, and completes the cart.

## Platform Dashboard Scope

1. Create `apps/platform-dashboard` as a Vite React application.
2. Proxy `/medusa/*` requests to `MEDUSA_BACKEND_URL`.
3. Show Medusa health by calling `/health`.
4. Show Store API availability by calling `/store/products`.
5. Show Admin auth availability by calling `/auth/user/emailpass`.
6. Link to Medusa Admin and the local Storefront.
7. Add placeholder sections for later logs, traffic generation, behavior flows, generated tests, and reports.

## Verification

1. Add root helper scripts for both dev servers and production builds.
2. Add `scripts/check-phase3.mjs` for file/configuration verification.
3. Run dependency installation for each frontend app.
4. Run `npm run check:phase3`.
5. Run `npm run storefront:build` and `npm run dashboard:build`.
6. Start both apps locally and verify their pages load.
7. Verify the storefront can register/login a customer, create/check a cart, and complete a Medusa checkout.
