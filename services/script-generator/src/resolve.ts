// Never hardcodes a seeded ID (CLAUDE.md §5) — every `{id}` in a path is
// either captured from a prior response in the SAME flow or fetched via a
// standalone GET emitted just before the step that needs it.
import type { OasDocument, OasMethod, OasSchema } from "../../golden/src/oas-types.js";
import { isRefSchema } from "../../golden/src/oas-types.js";
import type { CandidateStep } from "./load.js";

export interface OasSpecs {
  store: OasDocument;
  admin: OasDocument;
}

export type BodyFieldValue =
  | { kind: "literal"; value: string | number | boolean }
  | { kind: "runtime"; ref: string }
  /** Raw JS expression emitted verbatim into the spec (e.g. an in-scope `email` const or a `process.env.*` read). */
  | { kind: "raw"; expr: string };

export type SynthesizedBody = Record<string, BodyFieldValue>;

export type BodyPlan =
  | { kind: "observed"; payload: unknown }
  | { kind: "synthesized"; fields: SynthesizedBody }
  | { kind: "empty" }
  | { kind: "unresolvable"; reason: string };

// Params are an ORDERED list (by occurrence in the template), not a name-keyed
// map: a path can repeat a param name (`/store/carts/{id}/line-items/{id}`), and
// a map would overwrite the first binding and leave the second `{id}`
// unsubstituted. emit.ts substitutes them left-to-right by occurrence.
export type PathPlan = { template: string; params: { param: string; varName: string }[] };

/** A resolve call emitted BEFORE the step's main request, to populate scope. */
export interface ResolveCall {
  bindTo: string;
  method: string;
  endpoint: string;
  extract: string;
  auth: AuthRequirement;
  /** When set, select the bound entity by PREDICATE from a list response instead
   * of a fixed index: emit `list.find(it => <predicate>) ?? list[0]` and bind
   * `<field>`. Used where the wrong-state risk can't be filtered server-side (e.g.
   * an admin order that must be cancelable — not canceled AND not fulfilled).
   * Falls back to the first element so the resolve never throws; a genuinely
   * absent state then surfaces as the downstream step's own status mismatch.
   * `fromEnd` scans from the tail (oldest), used to keep two flows that want the
   * same state off the same entity (cancel takes the oldest, fulfillment newest). */
  select?: { collection: string; predicate: string; field: string; fromEnd?: boolean };
  /** When set, bind `scope.<bindTo>` to this literal id and emit NO request —
   * used for an auth-gated resource that an unauthenticated negative step can
   * never create (the gate 4xx's before resource lookup, so a placeholder id
   * reproduces the asserted status). */
  literal?: string;
  /** Inline request body for a bootstrap mutation (e.g. `POST /store/carts` needs `region_id`). */
  body?: SynthesizedBody;
  /** Required query params for a resolving GET (e.g. `GET /store/payment-providers` needs `region_id`). */
  query?: SynthesizedBody;
  /** When true, the resolve runs but its status is NOT asserted — used for an
   * idempotent "ensure state" mutation that may legitimately 4xx (e.g. fulfilling
   * an order another flow / a prior run already fulfilled). The goal is the
   * post-condition (the order is fulfilled), not this call's status. */
  bestEffort?: boolean;
}

export type AuthRequirement = "publishable-key" | "customer-token" | "admin-token" | "none";

export interface StepPlan {
  step: CandidateStep;
  resolveCalls: ResolveCall[];
  path: PathPlan;
  /** Required query params synthesized from the OAS (e.g. `cart_id`, `region_id`), filled from runtime scope. */
  query: SynthesizedBody;
  body: BodyPlan;
  auth: AuthRequirement;
  captures: Record<string, string>;
}

export interface FlowPlan {
  steps: StepPlan[];
  /** Steps whose path input could not be resolved — reported as generation errors, never silently dropped. */
  errors: string[];
}

const PUBLISHABLE = "publishable-key" as const;
const CUSTOMER = "customer-token" as const;
const ADMIN = "admin-token" as const;
const NONE = "none" as const;

function authFor(endpoint: string, requiresAuth: boolean): AuthRequirement {
  if (endpoint.startsWith("/admin/")) return ADMIN;
  if (endpoint.startsWith("/auth/")) return NONE;
  return requiresAuth ? CUSTOMER : PUBLISHABLE;
}

function pathParamNames(endpoint: string): string[] {
  const names: string[] = [];
  const re = /\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(endpoint))) {
    names.push(m[1]);
  }
  return names;
}

function captureRulesFor(method: string, endpoint: string): Record<string, string> {
  if (method === "GET" && endpoint === "/store/products")
    return { productId: "products[0].id", variantId: "products[0].variants[0].id" };
  if (method === "POST" && endpoint === "/store/carts") return { cartId: "cart.id" };
  // Medusa v2 `POST …/line-items` returns the whole `{ cart }`, not `{ line_item }`
  // — read the new line item off the cart's items array, else the
  // best-effort capture silently misses and an update step can't resolve its id.
  if (method === "POST" && endpoint === "/store/carts/{id}/line-items") return { lineItemId: "cart.items[0].id" };
  // An admin order fetched mid-flow exposes its line items, the ids a subsequent
  // fulfillment/return body references (a fulfillment fulfills the order's lines).
  if (method === "GET" && endpoint === "/admin/orders/{id}") return { lineItemId: "order.items[0].id" };
  // Begin-return returns the just-created return (with an active order change);
  // the lifecycle steps that follow (request-items, request, receive…) must
  // operate on THAT return, not an arbitrary `returns[0]` from the list (which
  // has no active order change → "An active Order Change is required").
  if (method === "POST" && endpoint === "/admin/returns") return { returnId: "return.id" };
  // Checkout reads that produce an id a later mutation needs in its body: the
  // shipping-method step takes `option_id` and the payment-session step takes
  // `provider_id`. Binding them here lets the full checkout chain thread end to
  // end (GET appears before the POST that consumes it in the mined journey).
  if (method === "GET" && endpoint === "/store/shipping-options") return { shippingOptionId: "shipping_options[0].id" };
  if (method === "GET" && endpoint === "/store/payment-providers") return { paymentProviderId: "payment_providers[0].id" };
  // Admin product-create prerequisites: when the mined flow already
  // lists these, capture the ids so the `POST /admin/products` body threads them
  // without a separate standalone resolver GET.
  if (method === "GET" && endpoint === "/admin/shipping-profiles") return { shippingProfileId: "shipping_profiles[0].id" };
  if (method === "GET" && endpoint === "/admin/sales-channels") return { salesChannelId: "sales_channels[0].id" };
  if (method === "POST" && endpoint === "/store/payment-collections") return { paymentCollectionId: "payment_collection.id" };
  if (method === "POST" && (endpoint === "/auth/customer/emailpass" || endpoint === "/auth/customer/emailpass/register"))
    return { customerToken: "$raw" };
  if (method === "POST" && endpoint === "/auth/user/emailpass") return { adminToken: "$raw" };
  return {};
}

function scopeVarForParam(param: string, endpoint: string, occurrence: number): string {
  // Cart line-item update: `/store/carts/{id}/line-items/{id}` carries two
  // identically-named path params (the normalizer collapses both to `{id}`).
  // Disambiguate positionally: the first id is the cart, the SECOND (after
  // `line-items`) is the line item.
  if (endpoint.startsWith("/store/carts") && endpoint.includes("/line-items/") && occurrence === 1) {
    return "lineItemId";
  }
  if (endpoint.startsWith("/admin/orders")) return "orderId";
  if (endpoint.startsWith("/admin/products")) return "productId";
  if (endpoint.startsWith("/admin/inventory-items")) return "inventoryItemId";
  if (endpoint.startsWith("/admin/returns")) return "returnId";
  if (endpoint.startsWith("/store/orders")) return "orderId";
  if (endpoint.startsWith("/store/products")) return "productId";
  if (endpoint.startsWith("/store/carts")) return "cartId";
  if (endpoint.startsWith("/store/payment-collections")) return "paymentCollectionId";
  return param;
}

type ResolveStep = {
  bindTo: string;
  method: string;
  endpoint: string;
  extract: string;
  /** See ResolveCall.select — predicate selection from a list response. */
  select?: { collection: string; predicate: string; field: string; fromEnd?: boolean };
  body?: SynthesizedBody;
  query?: SynthesizedBody;
  bestEffort?: boolean;
};

/** Scope vars whose standalone resolver must MUTATE an auth-gated resource (a
 * cart or payment collection — both behind the requireCustomerAuth gate). They
 * are unreachable in an unauthenticated context, so a negative (4xx) guest step
 * binds a placeholder id instead of resolving them. */
const AUTH_GATED_RESOURCE_VARS = new Set(["cartId", "paymentCollectionId"]);

function placeholderIdFor(varName: string): string {
  if (varName === "cartId") return "cart_unauthorized";
  if (varName === "paymentCollectionId") return "paycol_unauthorized";
  return `${varName}_unauthorized`;
}

// Most scope variables resolve via a single GET; `cartId` is a short bootstrap
// chain (`GET /store/regions` -> `POST /store/carts`) since a cart is a
// runtime-created resource, never a literal/seeded id (CLAUDE.md §5).
// A pending admin order WITH its line items inlined — `fields=*items` so the
// list response carries `items[].id` (the default list omits them). Used by the
// return-lifecycle bootstrap to read a line-item id without a second round-trip.
const ADMIN_PENDING_ORDERS_WITH_ITEMS = "/admin/orders?status[]=pending&order=-created_at&fields=*items";

function standaloneResolverFor(
  varName: string,
  auth: AuthRequirement,
  fulfilledOrder = false,
  // When the consuming flow CANCELS the order, pick from the OLD end of the
  // cancelable set. Cancel and fulfillment both want a pending, uncanceled,
  // unfulfilled order, but only the newest orders still hold a stock
  // reservation (fulfillment 400s "No stock reservation found" without one). So
  // fulfillment keeps the newest match and cancel yields it, taking the oldest —
  // cancel has no reservation requirement, so an older order cancels fine.
  cancelFlow = false
): ResolveStep[] | null {
  switch (varName) {
    case "regionId":
      return [{ bindTo: varName, method: "GET", endpoint: "/store/regions", extract: "regions[0].id" }];
    case "productId":
      // Admin and store both list products under a `products` envelope, but the
      // admin step carries an admin token (and the store list rejects it), so the
      // resolver must follow the step's auth context — same pattern as orderId.
      return auth === ADMIN
        ? [{ bindTo: varName, method: "GET", endpoint: "/admin/products", extract: "products[0].id" }]
        : [{ bindTo: varName, method: "GET", endpoint: "/store/products", extract: "products[0].id" }];
    case "variantId":
      return [{ bindTo: varName, method: "GET", endpoint: "/store/products", extract: "products[0].variants[0].id" }];
    case "inventoryItemId":
      // Admin-only resource (no store analog). Order by NEWEST: the only consumer,
      // `POST …/location-levels`, runs in a flow that just created a product, whose
      // inventory item is UNSTOCKED (location_levels: []). An arbitrary
      // `inventory_items[0]` is often an already-stocked seed item → the create
      // 400s ("Inventory level … already exists"). The newest item is the one the
      // product-create step just made — unstocked, so the level create succeeds.
      // VERIFY: list is non-empty in the seeded backend.
      return [{ bindTo: varName, method: "GET", endpoint: "/admin/inventory-items?order=-created_at", extract: "inventory_items[0].id" }];
    case "returnId":
      // Admin-only resource. // VERIFY: a return must already exist in the seeded
      // backend for the lifecycle steps to bind a real id.
      return [{ bindTo: varName, method: "GET", endpoint: "/admin/returns", extract: "returns[0].id" }];
    case "stockLocationId":
      // The `location_id` required by fulfillment/inventory bodies is a stock
      // location id; list them admin-side. // VERIFY: list is non-empty (the seed
      // creates at least one stock location).
      return [{ bindTo: varName, method: "GET", endpoint: "/admin/stock-locations", extract: "stock_locations[0].id" }];
    case "shippingProfileId":
      // `POST /admin/products` requires a shipping profile. // VERIFY: the seed creates one.
      return [{ bindTo: varName, method: "GET", endpoint: "/admin/shipping-profiles", extract: "shipping_profiles[0].id" }];
    case "salesChannelId":
      // `POST /admin/products` links a sales channel so the variant is purchasable
      // in /store. // VERIFY: the seed has a "Default Sales Channel".
      return [{ bindTo: varName, method: "GET", endpoint: "/admin/sales-channels", extract: "sales_channels[0].id" }];
    case "orderId":
      if (auth === ADMIN && fulfilledOrder) {
        // Return-lifecycle bootstrap: a return requires a FULFILLED order
        // ("Cannot request to return more items than what was fulfilled"), but
        // every seeded pending order is `not_fulfilled`. So pick an order, read
        // its line item, and fulfill it before the return begins. Two details:
        //  • Use `orders[1]`, NOT `orders[0]`: the cancel and fulfillment flows
        //    both claim `orders[0]`, and fulfilling it here would make cancel 400
        //    ("All fulfillments must be canceled first"). A distinct order keeps
        //    those flows undisturbed.
        //  • The fulfillment is bestEffort: another flow (or a prior run) may have
        //    already fulfilled this order — that 400 is fine; the post-condition
        //    (order is fulfilled) is what the return needs, not this call's status.
        return [
          { bindTo: "orderId", method: "GET", endpoint: ADMIN_PENDING_ORDERS_WITH_ITEMS, extract: "orders[1].id" },
          { bindTo: "lineItemId", method: "GET", endpoint: ADMIN_PENDING_ORDERS_WITH_ITEMS, extract: "orders[1].items[0].id" },
          { bindTo: "stockLocationId", method: "GET", endpoint: "/admin/stock-locations", extract: "stock_locations[0].id" },
          {
            bindTo: "fulfillmentSeed",
            method: "POST",
            endpoint: "/admin/orders/{orderId}/fulfillments",
            extract: "",
            bestEffort: true,
            body: {
              items: { kind: "raw", expr: "[{ id: scope.lineItemId, quantity: 1 }]" },
              location_id: { kind: "runtime", ref: "stockLocationId" },
            },
          },
        ];
      }
      // ADMIN: pick a genuinely CANCELABLE order. Filtering to `status[]=pending`
      // is not enough — a pending order can carry a partial fulfillment, and
      // `POST /admin/orders/{id}/cancel` 400s ("All fulfillments must be canceled
      // first") on those, exactly the residual the resolver-agent repair couldn't
      // land deterministically (see memory resolver-agent-repair). So request the
      // state fields and SELECT the first order that is not canceled AND has no
      // fulfillments. `fields=*fulfillments` inlines the relation on the list
      // response; the predicate runs client-side because Medusa has no
      // server-side "uncancelable" filter. This bakes the fix the AI agent would
      // have authored into the deterministic emit (no agent needed next run).
      return auth === ADMIN
        ? [{
            bindTo: varName,
            method: "GET",
            endpoint: "/admin/orders?status[]=pending&order=-created_at&fields=id,status,canceled_at,*fulfillments",
            extract: "",
            select: {
              collection: "orders",
              predicate: "!it.canceled_at && (it.fulfillments?.length ?? 0) === 0",
              field: "id",
              fromEnd: cancelFlow,
            },
          }]
        : [{ bindTo: varName, method: "GET", endpoint: "/store/orders", extract: "orders[0].id" }];
    case "cartId":
      // A bootstrapped cart must be NON-EMPTY: a mined checkout flow frequently
      // drops the `POST line-items` step (PrefixSpan keeps the frequent backbone),
      // so the cart this resolver creates would otherwise reach `shipping-methods`
      // / `complete` empty -> 400 ("Cannot complete a cart with no items"). Seed a
      // single in-stock line item here so every resolved cart is completable. The
      // line-items POST is path-templated on the just-created cart id (emit
      // substitutes `{cartId}` from scope); its `cart.id` rebind is a harmless
      // throwaway var (rebinding `cartId` would be skipped as already-in-scope).
      return [
        { bindTo: "regionId", method: "GET", endpoint: "/store/regions", extract: "regions[0].id" },
        {
          bindTo: varName,
          method: "POST",
          endpoint: "/store/carts",
          extract: "cart.id",
          body: { region_id: { kind: "runtime", ref: "regionId" } },
        },
        { bindTo: "variantId", method: "GET", endpoint: "/store/products", extract: "products[0].variants[0].id" },
        {
          bindTo: "cartSeed",
          method: "POST",
          endpoint: "/store/carts/{cartId}/line-items",
          extract: "", // side-effecting seed: add an item, bind nothing
          body: {
            variant_id: { kind: "runtime", ref: "variantId" },
            quantity: { kind: "literal", value: 1 },
          },
        },
      ];
    case "lineItemId":
      // A cart line-item update needs a line item id even when no prior add step
      // captured one. Bootstrap a cart (the cartId chain seeds one
      // in-stock line item), then read it back off the cart. The cart chain's
      // bindTos are skipped by `ensure` if cartId was already resolved earlier.
      return [
        ...standaloneResolverFor("cartId", auth)!,
        { bindTo: varName, method: "GET", endpoint: "/store/carts/{cartId}", extract: "cart.items[0].id" },
      ];
    case "paymentCollectionId":
      // The cart need only exist (no line items required to open a payment
      // collection), so the standard `regions -> carts` bootstrap suffices.
      return [
        ...standaloneResolverFor("cartId", auth)!,
        {
          bindTo: varName,
          method: "POST",
          endpoint: "/store/payment-collections",
          extract: "payment_collection.id",
          body: { cart_id: { kind: "runtime", ref: "cartId" } },
        },
      ];
    case "paymentProviderId":
      // Payment providers are scoped to a region; the listing endpoint requires
      // `region_id` as a query param.
      return [
        { bindTo: "regionId", method: "GET", endpoint: "/store/regions", extract: "regions[0].id" },
        {
          bindTo: varName,
          method: "GET",
          endpoint: "/store/payment-providers",
          extract: "payment_providers[0].id",
          query: { region_id: { kind: "runtime", ref: "regionId" } },
        },
      ];
    case "shippingOptionId":
      // Shipping options are computed per cart; the listing requires `cart_id`.
      // // VERIFY: an item-less cart may return no options (shipping_options[0]
      // undefined) — a shipping-methods step that needs this id then fails its own
      // status assertion cleanly rather than skipping.
      return [
        ...standaloneResolverFor("cartId", auth)!,
        {
          bindTo: varName,
          method: "GET",
          endpoint: "/store/shipping-options",
          extract: "shipping_options[0].id",
          query: { cart_id: { kind: "runtime", ref: "cartId" } },
        },
      ];
    default:
      return null;
  }
}

// The log-ingestion normalizer collapses EVERY id-like segment to `{id}`, so the
// cart line-item update mines as `/store/carts/{id}/line-items/{id}` — but the
// OAS keys the second param `{line_id}`. Alias the lookup so the update body
// schema (with required `quantity`) is found. This is the ONLY store
// path with ≥2 path params, so a targeted alias suffices.
const OAS_PATH_ALIASES: Record<string, string> = {
  "/store/carts/{id}/line-items/{id}": "/store/carts/{id}/line-items/{line_id}",
};

function requestSchemaFor(
  specs: OasSpecs,
  method: string,
  endpoint: string
): { doc: OasDocument; schema: OasSchema } | null {
  const lookup = OAS_PATH_ALIASES[endpoint] ?? endpoint;
  for (const doc of [specs.store, specs.admin]) {
    const pathItem = doc.paths[lookup];
    const operation = pathItem?.[method.toLowerCase() as OasMethod];
    const requestBody = (operation as { requestBody?: { content?: Record<string, { schema: OasSchema }> } } | undefined)
      ?.requestBody;
    const schema = requestBody?.content?.["application/json"]?.schema;
    if (schema) return { doc, schema };
  }
  return null;
}

interface FlatField {
  name: string;
  required: boolean;
  type: string;
  schema: OasSchema;
}

function resolveSchemaRef(doc: OasDocument, schema: OasSchema): { properties: Record<string, OasSchema>; required: string[] } {
  if (isRefSchema(schema)) {
    const match = /^#\/components\/schemas\/(.+)$/.exec(schema.$ref);
    const resolved = match ? doc.components.schemas[match[1]] : undefined;
    if (!resolved) return { properties: {}, required: [] };
    return resolveSchemaRef(doc, resolved);
  }
  if ("oneOf" in schema && schema.oneOf) {
    // Treat the first branch as the canonical minimal shape.
    return resolveSchemaRef(doc, schema.oneOf[0]);
  }
  if ("allOf" in schema && schema.allOf) {
    const merged: Record<string, OasSchema> = {};
    const required: string[] = [];
    for (const branch of schema.allOf) {
      const flat = resolveSchemaRef(doc, branch);
      Object.assign(merged, flat.properties);
      required.push(...flat.required);
    }
    return { properties: merged, required };
  }
  if ("properties" in schema && schema.properties) {
    return { properties: schema.properties, required: schema.required ?? [] };
  }
  return { properties: {}, required: [] };
}

function leafTypeOf(doc: OasDocument, schema: OasSchema): string {
  if (isRefSchema(schema)) {
    const match = /^#\/components\/schemas\/(.+)$/.exec(schema.$ref);
    const resolved = match ? doc.components.schemas[match[1]] : undefined;
    return resolved ? leafTypeOf(doc, resolved) : "object";
  }
  if ("oneOf" in schema && schema.oneOf) return leafTypeOf(doc, schema.oneOf[0]);
  if ("allOf" in schema && schema.allOf) return "object";
  if ("type" in schema && typeof schema.type === "string") return schema.type;
  return "object";
}

function flattenRequiredFields(doc: OasDocument, schema: OasSchema): FlatField[] {
  const { properties, required } = resolveSchemaRef(doc, schema);
  const requiredSet = new Set(required);
  return Object.entries(properties)
    .filter(([name]) => requiredSet.has(name))
    .map(([name, child]) => ({ name, required: true, type: leafTypeOf(doc, child), schema: child }));
}

/** Resolve a schema down to its concrete shape (follow $ref, collapse oneOf to
 * the first branch) so nested `items`/`properties` are reachable. Unlike
 * resolveSchemaRef (which flattens to {properties, required}), this returns the
 * schema node itself — needed to read an array's `items`. */
function derefSchema(doc: OasDocument, schema: OasSchema): OasSchema {
  if (isRefSchema(schema)) {
    const match = /^#\/components\/schemas\/(.+)$/.exec(schema.$ref);
    const resolved = match ? doc.components.schemas[match[1]] : undefined;
    return resolved ? derefSchema(doc, resolved) : schema;
  }
  if ("oneOf" in schema && schema.oneOf) return derefSchema(doc, schema.oneOf[0]);
  return schema;
}

/**
 * Recursively synthesize a JS expression for a value of `schema` (ADR: bodies are
 * derived from the OAS, which fully describes nested arrays/objects — the
 * synthesizer just has to walk into them). Returns a code string for emit's
 * `raw` field kind, or null when a required leaf can be neither a literal nor a
 * runtime-resolved id (caller decides omit-vs-unresolvable per edge semantics).
 *
 * - id-typed fields (ID_FIELD_TO_SCOPE) -> a runtime `scope.<var>`, bootstrapped
 *   via `ensure` exactly as top-level id fields are.
 * - scalars -> literal placeholders (number/integer 1, boolean true, string
 *   `test-<field>`), matching the top-level scalar synthesis byte-for-byte.
 * - object -> `{ ... }` over its REQUIRED sub-fields (an object with no required
 *   fields, e.g. `metadata`, becomes `{}`).
 * - array -> a single synthesized element wrapped in `[ ... ]`.
 *
 * NOTE: a generic `id` inside an array element (e.g. fulfillment/return
 * `items[].id`, an order line-item id) has no field-name hint, so it falls to
 * the string placeholder and the live call may 4xx — a runnable test artifact,
 * not a skip. Resolving it needs path-param resolve calls (see scope notes).
 */
function synthValueExpr(
  doc: OasDocument,
  schema: OasSchema,
  fieldName: string,
  ensure: (varName: string) => boolean,
  edgeOmit: boolean
): string | null {
  const scopeVar = ID_FIELD_TO_SCOPE[fieldName];
  if (scopeVar) return ensure(scopeVar) ? `scope.${scopeVar}` : null;

  const type = leafTypeOf(doc, schema);
  if (type === "number" || type === "integer") return "1";
  if (type === "boolean") return "true";
  if (type === "string") return JSON.stringify(`test-${fieldName}`);

  if (type === "object") {
    const { properties, required } = resolveSchemaRef(doc, schema);
    const parts: string[] = [];
    for (const name of required) {
      const child = properties[name];
      if (!child) continue;
      const expr = synthValueExpr(doc, child, name, ensure, edgeOmit);
      if (expr === null) {
        if (edgeOmit) continue;
        return null;
      }
      parts.push(`${JSON.stringify(name)}: ${expr}`);
    }
    return parts.length > 0 ? `{ ${parts.join(", ")} }` : "{}";
  }

  if (type === "array") {
    const items = (derefSchema(doc, schema) as { items?: OasSchema }).items;
    if (!items) return "[]";
    const expr = synthValueExpr(doc, items, fieldName, ensure, edgeOmit);
    if (expr === null) return edgeOmit ? "[]" : null;
    return `[${expr}]`;
  }

  return null;
}

const ID_FIELD_TO_SCOPE: Record<string, string> = {
  region_id: "regionId",
  variant_id: "variantId",
  option_id: "shippingOptionId",
  provider_id: "paymentProviderId",
  cart_id: "cartId",
  location_id: "stockLocationId",
};

/**
 * Required ID-typed fields resolve to runtime scope variables — bootstrapping
 * them via `ensure` (a standalone GET or the `regions -> carts` cart chain)
 * exactly as path and query params do, so e.g. a customer
 * `POST /store/payment-collections` fragment that needs a `cart_id` in its BODY
 * gets a real runtime cart instead of bailing out. Returns `unresolvable` only
 * when a required ID field can be neither captured nor bootstrapped — UNLESS
 * `edgeOmitOnFailure` is set (the step's logged `expected_status` is itself a
 * 4xx/5xx), in which case an unsynthesizable required field is deliberately
 * OMITTED: that reproduces the logged missing-required-field condition rather
 * than guessing a malformed value.
 */
/**
 * Negative-input body for an error-terminal step whose 4xx is caused by an
 * INVALID VALUE, not a missing required field. Structural omission (the
 * `edgeOmitOnFailure` path) can only reproduce missing-field failures; an
 * invalid-promo or invalid-variant 400 is a well-formed request carrying a bad
 * value, so we synthesize that value here. These mirror the traffic generator's
 * own negative probes (edge.ts invalid variant, the invalid promo code), so the
 * emitted body matches observed FAILING traffic rather than inventing a new
 * malformation. Returns null for endpoints with no known invalid-value failure
 * (callers fall through to structural synthesis).
 */
function negativeInputBody(method: string, endpoint: string): BodyPlan | null {
  if (method !== "POST") return null;
  // Bad login -> 401 "Invalid email or password". The happy path threads the
  // in-scope (registered) email/password via authCredentialBody; here a fresh,
  // never-registered email forces the auth failure (mirrors edge.ts bad_login,
  // which logs in with a brand-new email + "wrong-password").
  if (endpoint === "/auth/customer/emailpass") {
    return {
      kind: "synthesized",
      fields: {
        email: { kind: "raw", expr: "`badlogin-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`" },
        password: { kind: "literal", value: "wrong-password" },
      },
    };
  }
  // Invalid promotion code -> 400 "The promotion code ... is invalid". A promo is
  // applied via a cart update (`POST /store/carts/{id}` with `promo_codes`); a
  // code that is never seeded fails validation regardless of cart contents.
  if (endpoint === "/store/carts/{id}") {
    return {
      kind: "synthesized",
      fields: { promo_codes: { kind: "raw", expr: '["INVALID_PROMO_DO_NOT_SEED"]' } },
    };
  }
  // Invalid variant -> 400 "Variants ... do not exist or belong to a product that
  // is not published". Keep the value deliberately NON Medusa-id-shaped so the
  // generated hardcoded-id gate does not mistake this negative input for a seeded
  // fixture id.
  if (endpoint === "/store/carts/{id}/line-items") {
    return {
      kind: "synthesized",
      fields: {
        variant_id: { kind: "literal", value: "invalid-variant-do-not-seed" },
        quantity: { kind: "literal", value: 1 },
      },
    };
  }
  return null;
}

function synthesizeBody(
  specs: OasSpecs,
  method: string,
  endpoint: string,
  ensure: (varName: string) => boolean,
  edgeOmitOnFailure: boolean
): BodyPlan {
  const found = requestSchemaFor(specs, method, endpoint);
  if (!found) {
    return { kind: "empty" };
  }
  // Fulfillment `items` are the order's line items — a generic array synthesizer
  // can fill `quantity` but not the line-item `id` (a bare `id` field carries no
  // resolvable hint). When the flow fetched the order first (lineItemId captured,
  // see captureRulesFor), thread the real id; otherwise fall back to a placeholder
  // and let the call 4xx honestly rather than skip.
  // `POST /admin/returns`: the OAS schema is $ref/allOf-heavy and the
  // generic synth emits `order_id: "test-order_id"` (placeholder) → 404. Mirror
  // the traffic generator's known-good body: a pending order id + a stock
  // location. Both resolve via standalone admin GETs, threaded by `ensure`.
  if (method === "POST" && endpoint === "/admin/returns" && ensure("orderId") && ensure("stockLocationId")) {
    return {
      kind: "synthesized",
      fields: {
        order_id: { kind: "runtime", ref: "orderId" },
        location_id: { kind: "runtime", ref: "stockLocationId" },
      },
    };
  }
  // Return-lifecycle item steps: `request-items` / `receive-items` take the
  // ORDER's line-item id (not a placeholder), the same `lineItemId` the begin
  // bootstrap bound from the fulfilled order. The generic synth emits a bare
  // `id: "test-id"` (an array element's id carries no field-name hint) → 400.
  if (
    method === "POST" &&
    (endpoint === "/admin/returns/{id}/request-items" || endpoint === "/admin/returns/{id}/receive-items") &&
    ensure("lineItemId")
  ) {
    return {
      kind: "synthesized",
      fields: { items: { kind: "raw", expr: "[{ id: scope.lineItemId, quantity: 1 }]" } },
    };
  }
  // `POST /admin/products`: the generic synth emits only `{ title }` →
  // "Product options are not provided". Mirror admin-session.ts createProduct: a
  // published product with one "One Size" variant, a shipping profile, and a
  // sales-channel link (so the variant is purchasable in /store). currency_code
  // "eur" matches the seed's single European region (kept hardcoded); title/SKU
  // use Date.now() for uniqueness across reruns.
  if (method === "POST" && endpoint === "/admin/products" && ensure("shippingProfileId") && ensure("salesChannelId")) {
    return {
      kind: "synthesized",
      fields: {
        title: { kind: "raw", expr: "`GEN-${Date.now()}`" },
        status: { kind: "literal", value: "published" },
        shipping_profile_id: { kind: "runtime", ref: "shippingProfileId" },
        options: { kind: "raw", expr: `[{ title: "Size", values: ["One Size"] }]` },
        variants: {
          kind: "raw",
          expr: '[{ title: "Default", sku: `GEN-${Date.now()}`, options: { Size: "One Size" }, prices: [{ amount: 1500, currency_code: "eur" }] }]',
        },
        sales_channels: { kind: "raw", expr: "[{ id: scope.salesChannelId }]" },
      },
    };
  }
  if (method === "POST" && endpoint.endsWith("/fulfillments") && ensure("stockLocationId")) {
    const itemId = ensure("lineItemId") ? "scope.lineItemId" : JSON.stringify("test-id");
    return {
      kind: "synthesized",
      fields: {
        items: { kind: "raw", expr: `[{ id: ${itemId}, quantity: 1 }]` },
        location_id: { kind: "runtime", ref: "stockLocationId" },
        metadata: { kind: "raw", expr: "{}" },
      },
    };
  }
  const fields = flattenRequiredFields(found.doc, found.schema);
  if (fields.length === 0) {
    return { kind: "empty" };
  }
  const synthesized: SynthesizedBody = {};
  for (const field of fields) {
    const scopeVar = ID_FIELD_TO_SCOPE[field.name];
    if (scopeVar) {
      if (!ensure(scopeVar)) {
        if (edgeOmitOnFailure) continue; // omit: reproduces the logged missing-required-field condition
        return {
          kind: "unresolvable",
          reason: `required field "${field.name}" needs runtime value "${scopeVar}", which no prior step or standalone resolver produced`,
        };
      }
      synthesized[field.name] = { kind: "runtime", ref: scopeVar };
      continue;
    }
    if (field.type === "number" || field.type === "integer") {
      synthesized[field.name] = { kind: "literal", value: 1 };
    } else if (field.type === "boolean") {
      synthesized[field.name] = { kind: "literal", value: true };
    } else if (field.type === "string") {
      synthesized[field.name] = { kind: "literal", value: `test-${field.name}` };
    } else {
      // Composite (array/object): the OAS describes the nested shape, so walk it.
      const expr = synthValueExpr(found.doc, field.schema, field.name, ensure, edgeOmitOnFailure);
      if (expr === null) {
        if (edgeOmitOnFailure) continue; // omit reproduces the logged missing-required-field condition
        return {
          kind: "unresolvable",
          reason: `required field "${field.name}" ("${field.type}") could not be synthesized from the OAS`,
        };
      }
      synthesized[field.name] = { kind: "raw", expr };
    }
  }
  if (Object.keys(synthesized).length === 0) {
    return { kind: "empty" };
  }
  return { kind: "synthesized", fields: synthesized };
}

/**
 * Auth-login endpoints are NOT documented in the store/admin OAS, so the schema
 * synthesizer would yield an empty body and the login would be sent with no
 * credentials -> 401. These three endpoints need REAL credentials, threaded
 * deterministically: admin login reads the same env the shared fixture uses;
 * customer register/login reuse the in-scope generated `email`/`password`
 * consts the emit setup declares, so a later login matches the registration.
 * Returns null for non-auth endpoints (fall through to OAS body synthesis).
 */
function authCredentialBody(method: string, endpoint: string): BodyPlan | null {
  if (method !== "POST") return null;
  if (endpoint === "/auth/user/emailpass") {
    return {
      kind: "synthesized",
      fields: {
        email: { kind: "raw", expr: 'process.env.MEDUSA_ADMIN_EMAIL ?? "admin@medusa-test.com"' },
        password: { kind: "raw", expr: 'process.env.MEDUSA_ADMIN_PASSWORD ?? "supersecret"' },
      },
    };
  }
  if (endpoint === "/auth/customer/emailpass" || endpoint === "/auth/customer/emailpass/register") {
    return {
      kind: "synthesized",
      fields: { email: { kind: "raw", expr: "email" }, password: { kind: "raw", expr: "password" } },
    };
  }
  // Creating the customer entity needs the SAME generated `email` the
  // register/login steps use, or the new customer record won't match the
  // authenticated identity. The generic synthesizer would emit an empty body
  // (no id-typed required field) -> 400. Thread the in-scope `email` const,
  // mirroring the auto-register setup.
  if (endpoint === "/store/customers") {
    return { kind: "synthesized", fields: { email: { kind: "raw", expr: "email" } } };
  }
  return null;
}

function requiredQueryParamsFor(specs: OasSpecs, method: string, endpoint: string): string[] {
  for (const doc of [specs.store, specs.admin]) {
    const operation = doc.paths[endpoint]?.[method.toLowerCase() as OasMethod];
    const params = (operation as { parameters?: { name: string; in?: string; required?: boolean }[] } | undefined)?.parameters;
    if (!params) continue;
    const required = params.filter((p) => p.in === "query" && p.required).map((p) => p.name);
    if (required.length > 0) return required;
  }
  return [];
}

/**
 * Append, just before a `POST /store/carts/{id}/complete`, the full checkout-
 * ready prep on the EXISTING `scope.cartId`: select a shipping method, THEN
 * create+initiate a payment session — in that order, LAST. A cart completes only
 * with both, and PrefixSpan frequently drops these prep steps while keeping
 * `complete` ("No shipping method selected" / "Payment sessions are required").
 *
 * Order matters and is why this runs unconditionally (not "only if the flow
 * lacks the step"): any cart mutation AFTER a payment session is created
 * invalidates it, so a flow that selects shipping after its own payment-session
 * step would 400 at complete. Re-doing each is safe — the live backend is
 * idempotent (re-selecting a shipping method / re-creating a payment collection
 * returns 200 with the same id), and the payment session is always (re)created
 * here as the final mutation. Path-templated endpoints are substituted from
 * scope by emit's resolveUrlExpr.
 */
function appendCheckoutReadyResolvers(
  resolveCalls: ResolveCall[],
  scope: Set<string>,
  auth: AuthRequirement
): void {
  // 1. Shipping method (must precede the payment session).
  if (!scope.has("shippingOptionId")) {
    resolveCalls.push({
      auth, bindTo: "shippingOptionId", method: "GET", endpoint: "/store/shipping-options",
      extract: "shipping_options[0].id", query: { cart_id: { kind: "runtime", ref: "cartId" } },
    });
    scope.add("shippingOptionId");
  }
  resolveCalls.push({
    auth, bindTo: "shippingMethodSet", method: "POST",
    endpoint: "/store/carts/{cartId}/shipping-methods", extract: "",
    body: { option_id: { kind: "runtime", ref: "shippingOptionId" } },
  });
  // 2. Payment session, created LAST so no later cart mutation invalidates it.
  if (!scope.has("regionId")) {
    resolveCalls.push({ auth, bindTo: "regionId", method: "GET", endpoint: "/store/regions", extract: "regions[0].id" });
    scope.add("regionId");
  }
  if (!scope.has("paymentCollectionId")) {
    resolveCalls.push({
      auth, bindTo: "paymentCollectionId", method: "POST", endpoint: "/store/payment-collections",
      extract: "payment_collection.id", body: { cart_id: { kind: "runtime", ref: "cartId" } },
    });
    scope.add("paymentCollectionId");
  }
  if (!scope.has("paymentProviderId")) {
    resolveCalls.push({
      auth, bindTo: "paymentProviderId", method: "GET", endpoint: "/store/payment-providers",
      extract: "payment_providers[0].id", query: { region_id: { kind: "runtime", ref: "regionId" } },
    });
    scope.add("paymentProviderId");
  }
  resolveCalls.push({
    auth, bindTo: "paymentSessionSet", method: "POST",
    endpoint: "/store/payment-collections/{paymentCollectionId}/payment-sessions", extract: "",
    body: { provider_id: { kind: "runtime", ref: "paymentProviderId" } },
  });
}

export function buildFlowPlan(
  steps: CandidateStep[],
  specs: OasSpecs,
  flowRequiresAuth: boolean
): FlowPlan {
  const scope = new Set<string>(["publishableKey"]);
  const plans: StepPlan[] = [];
  const errors: string[] = [];

  // A flow that exercises any return endpoint needs its admin order to be
  // FULFILLED before the return begins (see standaloneResolverFor orderId). The
  // signal is flow-wide because the order is resolved at the first GET
  // /admin/orders/{id} step, before the /admin/returns step is reached.
  const flowIsReturnLifecycle = steps.some((s) => s.endpoint.startsWith("/admin/returns"));

  // A cancel flow takes the OLDEST cancelable order so it doesn't strip the
  // newest (reservation-bearing) one the fulfillment flow needs — see
  // standaloneResolverFor's `cancelFlow` param.
  const flowIsCancel = steps.some(
    (s) => s.method === "POST" && /^\/admin\/orders\/\{[^}]+\}\/cancel$/.test(s.endpoint)
  );

  for (const step of steps) {
    let auth = authFor(step.endpoint, flowRequiresAuth);
    // Negative-auth downgrade: a step asserting 401 on a customer-gated
    // endpoint must reach the `requireCustomerAuth` gate WITHOUT a valid session
    // token, or the always-on setup handshake (emit.ts autoRegister) makes it
    // 200. Strip the customer token (drop to publishable-key only) for that one
    // step so the gate produces the asserted 401. The mechanism differs from the
    // mined broken-token cause (no-token vs broken-token), but the status-only
    // regression assertion holds. Guarded narrowly (customer auth + expected 401)
    // so other steps in the same flow keep the established token.
    if (auth === CUSTOMER && step.expected_status === 401) {
      auth = PUBLISHABLE;
    }
    const resolveCalls: ResolveCall[] = [];

    // Ensure a scope variable is available, emitting (chained) resolve calls if
    // not. Returns false when no prior step or standalone GET can produce it.
    const ensure = (varName: string): boolean => {
      if (scope.has(varName)) return true;
      // Unauthenticated context + a var whose resolver must CREATE an auth-gated
      // resource (a cart / payment collection) cannot be resolved: `POST
      // /store/carts` 401s without a customer token (the requireCustomerAuth gate,
      // gate-contract.ts). When the step itself asserts a 4xx, the gate fires on the
      // path prefix BEFORE any resource lookup, so a literal placeholder id
      // reproduces the same status — bind it instead of an impossible 200-expecting
      // resolve chain. A 2xx-asserting guest flow never reaches here: a successful
      // auth-dependent read reclassifies the whole flow as a customer (ADR 0006).
      const unauthenticated = auth === PUBLISHABLE || auth === NONE;
      if (unauthenticated && AUTH_GATED_RESOURCE_VARS.has(varName) && step.expected_status >= 400) {
        resolveCalls.push({
          bindTo: varName,
          literal: placeholderIdFor(varName),
          method: "GET",
          endpoint: "",
          extract: "",
          auth,
        });
        scope.add(varName);
        return true;
      }
      const chain = standaloneResolverFor(varName, auth, flowIsReturnLifecycle, flowIsCancel);
      if (!chain) return false;
      for (const call of chain) {
        if (scope.has(call.bindTo)) continue; // a chained prerequisite already resolved earlier in this flow
        resolveCalls.push({ ...call, auth });
        scope.add(call.bindTo);
      }
      return true;
    };

    const pathParams: { param: string; varName: string }[] = [];
    let stepFailed = false;

    const paramNames = pathParamNames(step.endpoint);
    for (let occurrence = 0; occurrence < paramNames.length; occurrence++) {
      const param = paramNames[occurrence];
      const varName = scopeVarForParam(param, step.endpoint, occurrence);
      if (ensure(varName)) {
        pathParams.push({ param, varName });
      } else {
        errors.push(
          `${step.method} ${step.endpoint}: path param "{${param}}" needs "${varName}", which no prior step produced and no standalone GET can resolve`
        );
        stepFailed = true;
      }
    }

    if (stepFailed) {
      continue;
    }

    // A step whose OWN expected_status is a 4xx/5xx omits an unresolvable
    // required query param instead of erroring — that omission reproduces the
    // logged structural condition rather than guessing a value.
    const query: SynthesizedBody = {};
    for (const name of requiredQueryParamsFor(specs, step.method, step.endpoint)) {
      const scopeVar = ID_FIELD_TO_SCOPE[name];
      if (!scopeVar) continue; // non-ID required query param: leave as-is (don't guess a value)
      if (ensure(scopeVar)) {
        query[name] = { kind: "runtime", ref: scopeVar };
      } else if (step.expected_status < 400) {
        errors.push(
          `${step.method} ${step.endpoint}: required query "${name}" needs "${scopeVar}", which no prior step or standalone GET can resolve`
        );
        stepFailed = true;
      }
    }

    if (stepFailed) {
      continue;
    }

    // `complete` needs a checkout-ready cart: inject the shipping-method /
    // payment-session prep the mined flow dropped (runs on the cartId just
    // ensured above). Only for a success-expecting complete — a negative one
    // asserts the gate/empty-cart 4xx and must not be made to succeed.
    if (
      step.method === "POST" &&
      step.endpoint === "/store/carts/{id}/complete" &&
      step.expected_status < 400
    ) {
      appendCheckoutReadyResolvers(resolveCalls, scope, auth);
    }

    // A step whose OWN logged expected_status is already a 4xx/5xx reproduces
    // that failure structurally (an omitted OAS-required field) — never invents
    // a new malformation.
    let body: BodyPlan;
    if (step.request_payload !== undefined) {
      body = { kind: "observed", payload: step.request_payload };
    } else {
      body =
        // Negative-input bodies win for error-terminal steps: a bad-login 401
        // needs WRONG credentials, so it must take precedence over the correct
        // creds authCredentialBody threads for the happy login.
        (step.expected_status >= 400 ? negativeInputBody(step.method, step.endpoint) : null) ??
        authCredentialBody(step.method, step.endpoint) ??
        synthesizeBody(specs, step.method, step.endpoint, ensure, step.expected_status >= 400);
    }

    const captures = captureRulesFor(step.method, step.endpoint);
    for (const varName of Object.keys(captures)) {
      scope.add(varName);
    }

    plans.push({
      step,
      resolveCalls,
      path: { template: step.endpoint, params: pathParams },
      query,
      body,
      auth,
      captures,
    });
  }

  return { steps: plans, errors };
}
