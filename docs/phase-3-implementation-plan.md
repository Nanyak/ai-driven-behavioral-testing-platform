# Phase 3 Implementation Plan

## Goal

Provide two local frontend applications for the behavioral testing platform:

- A full-featured Storefront that exercises Medusa Store APIs and exposes a rich set of shopper behaviors for future traffic generation and behavioral analysis.
- A Platform Dashboard that shows backend/API status and links to the local tools.

## Ports

| App | Port | URL |
| --- | --- | --- |
| Storefront | 8000 | `http://localhost:8000` |
| Platform Dashboard | 5173 | `http://localhost:5173` |
| Medusa Admin | 9000 | `http://localhost:9000/app` |

## Tech Stack

Both apps are Vite + React 19 + TypeScript. The storefront additionally uses:

- **Tailwind CSS v4** via `@tailwindcss/vite` plugin
- **shadcn/ui** components (`badge`, `button`, `card`, `input`, `label`, `select`, `separator`, `sheet`)
- **@base-ui/react** for headless UI primitives
- **lucide-react** for icons
- **Geist variable font** (`@fontsource-variable/geist`)

Build-time env injection uses Vite `define` (`__MEDUSA_PUBLISHABLE_API_KEY__`, `__MEDUSA_ADMIN_EMAIL__`, `__MEDUSA_ADMIN_PASSWORD__`). Both Vite configs load the root `.env` from the repository root (two directories up) via `loadEnv("", repoRoot, "")`.

## Storefront (`apps/storefront`)

### Structure

```
src/
  App.tsx                     — root component, composes StorefrontProvider + StorefrontRoutes
  main.tsx                    — React DOM entry point
  routing.ts                  — typed Route union, parseRoute(), productPath(), collectionPath(), sellerPath()
  styles.css                  — Tailwind v4 and global styles
  components/
    AppLink.tsx               — history.pushState navigation helper
    AuthForm.tsx              — shared sign-in / sign-up form
    CartSummary.tsx           — cart drawer / summary component
    ProductDetail.tsx         — single product view with variant picker
    ProductGrid.tsx           — product listing grid
    StoreHeader.tsx           — top navigation bar with cart badge, search, wishlist, notifications
    StoreHero.tsx             — homepage hero section
    ui/                       — shadcn/ui primitive components
  context/
    StorefrontContext.tsx     — all application state and async actions
  hooks/
    useRoute.ts               — reads window.location, listens to popstate
  lib/
    utils.ts                  — cn() helper (clsx + tailwind-merge)
  pages/
    CartPage.tsx
    CollectionPage.tsx
    ComparePage.tsx
    DealsPage.tsx
    HomePage.tsx
    NotificationsPage.tsx
    OrderPage.tsx
    OrdersPage.tsx
    ProductPage.tsx
    ProfilePage.tsx
    SellerPage.tsx
    SignInPage.tsx
    SignUpPage.tsx
    WishlistPage.tsx
  services/
    authToken.ts              — localStorage JWT helpers
    medusa.ts                 — typed Medusa Store API client
  types/
    storefront.ts             — Product, Variant, Cart, Order, Customer, and supporting types
  utils/
    marketplace.ts            — marketplace display helpers
    money.ts                  — currency formatting helpers
```

### Routing

Custom client-side routing using `history.pushState` and `popstate`. No `react-router` dependency. All routes are encoded as a typed `Route` union in `routing.ts` and resolved by `parseRoute(pathname)`.

| Route | Path pattern |
| --- | --- |
| home | `/` |
| product | `/products/:productId` |
| collection | `/collections/:collectionName` |
| seller | `/sellers/:sellerName` |
| deals | `/deals` |
| signin | `/signin` |
| signup | `/signup` |
| profile | `/profile` |
| wishlist | `/wishlist` |
| orders | `/orders` |
| order | `/orders/:orderId` |
| notifications | `/notifications` |
| compare | `/compare` |
| cart | `/cart` |

### Medusa API Client (`services/medusa.ts`)

All requests go through a `/medusa` Vite proxy that strips the prefix and forwards to `MEDUSA_BACKEND_URL`. Operations implemented in `medusaStore`:

- `listRegions()` — fetches available regions
- `listProducts()` — fetches up to 24 products with pricing, inventory, collection, tags, images
- `registerCustomer(email, password)` — creates auth token then creates customer record
- `loginCustomer(email, password)` — authenticates and fetches profile
- `getCustomer()` — fetches authenticated customer profile
- `createCart()` — creates a cart bound to the first region
- `getCart(cartId)`
- `getOrder(orderId)`
- `listOrders()` — authenticated orders
- `addLineItem(cartId, variantId, quantity)`
- `updateLineItem(cartId, lineItemId, quantity)`
- `deleteLineItem(cartId, lineItemId)`
- `getShippingOptions(cartId)`
- `getPaymentProviders(regionId)`
- `updateCheckoutAddress(cartId, address)`
- `applyPromoCode(cartId, promoCode)`
- `addShippingMethod(cartId, optionId)`
- `createPaymentCollection(cartId)`
- `createPaymentSession(collectionId, providerId)`
- `completeCart(cartId)`

### StorefrontContext

`StorefrontProvider` / `useStorefront()` manages all application state. All user-facing lists persist to `localStorage`.

**Persisted state** (localStorage keys: `behavior-storefront-*`):

| State | Key suffix | Capacity |
| --- | --- | --- |
| Wishlist product IDs | `wishlist` | unlimited |
| Recently viewed product IDs | `recently-viewed` | 12 |
| Compare product IDs | `compare` | 4 |
| Saved addresses | `addresses` | 6 |
| Product reviews | `reviews` | 100 |
| Product Q&A | `questions` | 100 |
| Order support requests | `support` | 100 |
| Notifications | `notifications` | 50 |
| Recent order IDs | `orders` | 20 |

**Session state** (not persisted): products, cart, customer, shipping options, payment providers, search query, selected variant, auth form fields, status message, checkout result, busy flag.

**Actions exposed via context:**

- Auth: `registerCustomer`, `loginCustomer`, `logoutCustomer`
- Products: `loadProducts`, `getProduct`, `getSelectedVariant`, `setSelectedVariantId`, `rememberViewedProduct`
- Cart: `addVariantToCart`, `updateCartItemQuantity`, `removeCartItem`, `applyPromoCode`
- Checkout: `prepareCheckout`, `runCheckout`
- Orders: `loadOrder`, `loadOrders`
- Wishlist: `toggleWishlist`, `isWishlisted`
- Compare: `toggleCompare`, `isCompared`
- Reviews: `submitReview`, `getProductReviews`
- Q&A: `submitProductQuestion`, `getProductQuestions`
- Support: `submitOrderSupportRequest`, `getOrderSupportRequests`
- Notifications: `markAllNotificationsRead`
- Address book: `saveAddress`
- Search: `setSearchQuery`

### Checkout flow

1. `prepareCheckout(address)` — update cart address/email, fetch shipping options and payment providers in parallel.
2. `runCheckout(shippingOptionId, paymentProviderId)` — add shipping method, create payment collection if needed, create payment session, complete cart.
3. On success: store order ID in recent orders, fire notification, clear cart.

## Platform Dashboard (`apps/platform-dashboard`)

Single-file React app (`src/main.tsx`). No router.

- Runs three async status checks on mount and on refresh: Medusa health (`/health`), Store API (`/store/products?limit=1`), Admin auth (`POST /auth/user/emailpass`).
- Displays each check as a status card (`checking` / `online` / `offline`).
- Quick links to Medusa Admin (`http://localhost:9000/app`) and Storefront (`http://localhost:8000`).
- Placeholder module cards for: Logs, Traffic generation, Behavior flows, Generated tests, Reports.
- Injects `__MEDUSA_PUBLISHABLE_API_KEY__`, `__MEDUSA_ADMIN_EMAIL__`, `__MEDUSA_ADMIN_PASSWORD__` at build time.

## Root Scripts

```bash
npm run storefront:dev      # vite --host 0.0.0.0 --port 8000 (from apps/storefront)
npm run storefront:build    # tsc -b && vite build (from apps/storefront)
npm run dashboard:dev       # vite --port 5173 (from apps/platform-dashboard)
npm run dashboard:build     # tsc -b && vite build (from apps/platform-dashboard)
npm run check:phase3        # scripts/check-phase3.mjs
```

## Verification

1. Run `npm run check:phase3` — verifies file and configuration presence.
2. Run `npm run storefront:build` and `npm run dashboard:build`.
3. Start both dev servers and confirm pages load at their expected ports.
4. Exercise the storefront: load products, sign up, sign in, add to cart, wishlist a product, compare products, go through checkout.
5. Confirm Platform Dashboard shows all three status checks as `online`.
