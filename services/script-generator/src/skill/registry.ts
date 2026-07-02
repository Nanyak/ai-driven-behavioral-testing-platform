/**
 * Skill library (Phase A). A "skill" is a named, reusable recipe that arranges a
 * specific entity into a specific state (e.g. `order@fulfilled`,
 * `inventoryItem@unstocked`, `region@any`). This module promotes the former
 * `standaloneResolverFor` switch in resolve.ts into a keyed, oracle-verified
 * registry.
 *
 * Trust contract (mirrors the invariants layer, see invariants/types.ts): a skill
 * is only fully trusted once its `oracle` has been checked against the live
 * known-good backend and HELD (`verified === true` in data/skills/skills.json).
 * Unlike invariants, an unverified skill is NOT dropped — generation must stay
 * deterministic and offline-runnable — but resolveSkill logs a one-time warning
 * so an unverified recipe can never quietly become load-bearing.
 *
 * The registry reproduces the old switch 1:1: the same ResolveStep arrays, in the
 * same order, for the same `(varName, auth, fulfilledOrder, cancelFlow)` inputs
 * (see resolveSkillForVar). Every code comment from the old switch is preserved
 * verbatim next to the recipe it explains — those comments encode subtle,
 * hard-won fixes.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuthRequirement, ResolveStep } from "../resolve.js";
import type { FieldInvariant, InvariantMatcher } from "../invariants/types.js";
import { evaluateInvariant } from "../invariants/evaluate.js";

export type { AuthRequirement, ResolveStep };

const ADMIN = "admin-token" as const;

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(__dirname, "..", "..", "..", "..");
export const SKILLS_ARTIFACT = resolvePath(REPO_ROOT, "data", "skills", "skills.json");

/** The identity of a skill: an entity plus the state it is arranged into. */
export interface SkillKey {
  entity: string;
  state: string;
}

/**
 * A skill's post-condition. REUSES the invariants matcher vocabulary
 * (InvariantMatcher) so verification agrees byte-for-byte with the invariants
 * layer's evaluator. `endpoint` names the resolve step whose response the oracle
 * reads (the skill's binding GET/POST); the many `// VERIFY:` prose comments in
 * the old switch become these executable checks.
 */
export interface SkillOracle {
  /** The resolve step endpoint whose response body this oracle asserts over. */
  endpoint: string;
  /** Dotted path into that response body (evaluate.ts getPath semantics). */
  path: string;
  matcher: InvariantMatcher;
  /** Expected value; omitted for nullary matchers (toBeDefined/toBeTruthy…). */
  expected?: string | number | boolean;
  /** One-line rationale — the prose the `// VERIFY:` comment carried. */
  rationale: string;
}

export interface Skill {
  key: SkillKey;
  /** The auth context this recipe is valid for. `"any"` matches every context;
   * an explicit AuthRequirement (e.g. `admin-token`) makes it auth-specific, used
   * where the same entity resolves via different endpoints per persona (product,
   * order). The emitted steps carry no auth themselves — the planner's `ensure`
   * stamps each with the consuming step's auth (as the old switch did). */
  auth: "any" | AuthRequirement;
  steps: ResolveStep[];
  oracle: SkillOracle;
  provenance: "deterministic" | "agent-authored";
}

/** Stable id for a skill (entity@state#auth) — the skills.json key. */
export function skillId(key: SkillKey, auth: Skill["auth"]): string {
  return `${key.entity}@${key.state}#${auth}`;
}

// ---------------------------------------------------------------------------
// Shared recipe fragments (were inline helpers / recursive calls in the switch).
// ---------------------------------------------------------------------------

// A pending admin order WITH its line items inlined — `fields=*items` so the
// list response carries `items[].id` (the default list omits them). Used by the
// return-lifecycle bootstrap to read a line-item id without a second round-trip.
const ADMIN_PENDING_ORDERS_WITH_ITEMS = "/admin/orders?status[]=pending&order=-created_at&fields=*items";

// Most scope variables resolve via a single GET; `cartId` is a short bootstrap
// chain (`GET /store/regions` -> `POST /store/carts`) since a cart is a
// runtime-created resource, never a literal/seeded id (CLAUDE.md §5).
//
// A bootstrapped cart must be NON-EMPTY: a mined checkout flow frequently
// drops the `POST line-items` step (PrefixSpan keeps the frequent backbone),
// so the cart this resolver creates would otherwise reach `shipping-methods`
// / `complete` empty -> 400 ("Cannot complete a cart with no items"). Seed a
// single in-stock line item here so every resolved cart is completable. The
// line-items POST is path-templated on the just-created cart id (emit
// substitutes `{cartId}` from scope); its `cart.id` rebind is a harmless
// throwaway var (rebinding `cartId` would be skipped as already-in-scope).
const CART_SEEDED_STEPS: ResolveStep[] = [
  { bindTo: "regionId", method: "GET", endpoint: "/store/regions", extract: "regions[0].id" },
  {
    bindTo: "cartId",
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

// ---------------------------------------------------------------------------
// The registry — one entry per old switch case (orderId & productId fan out).
// ---------------------------------------------------------------------------

export const SKILLS: Skill[] = [
  // case "regionId"
  {
    key: { entity: "region", state: "any" },
    auth: "any",
    provenance: "deterministic",
    steps: [{ bindTo: "regionId", method: "GET", endpoint: "/store/regions", extract: "regions[0].id" }],
    oracle: {
      endpoint: "/store/regions",
      path: "regions[0].id",
      matcher: "toBeDefined",
      rationale: "at least one region exists in the seeded backend",
    },
  },

  // case "productId" (admin branch)
  // Admin and store both list products under a `products` envelope, but the
  // admin step carries an admin token (and the store list rejects it), so the
  // resolver must follow the step's auth context — same pattern as orderId.
  {
    key: { entity: "product", state: "any" },
    auth: ADMIN,
    provenance: "deterministic",
    steps: [{ bindTo: "productId", method: "GET", endpoint: "/admin/products", extract: "products[0].id" }],
    oracle: {
      endpoint: "/admin/products",
      path: "products[0].id",
      matcher: "toBeDefined",
      rationale: "the admin product list is non-empty in the seeded backend",
    },
  },
  // case "productId" (store branch — the non-admin fallback)
  {
    key: { entity: "product", state: "any" },
    auth: "any",
    provenance: "deterministic",
    steps: [{ bindTo: "productId", method: "GET", endpoint: "/store/products", extract: "products[0].id" }],
    oracle: {
      endpoint: "/store/products",
      path: "products[0].id",
      matcher: "toBeDefined",
      rationale: "the store product list is non-empty in the seeded backend",
    },
  },

  // case "variantId"
  {
    key: { entity: "variant", state: "any" },
    auth: "any",
    provenance: "deterministic",
    steps: [{ bindTo: "variantId", method: "GET", endpoint: "/store/products", extract: "products[0].variants[0].id" }],
    oracle: {
      endpoint: "/store/products",
      path: "products[0].variants[0].id",
      matcher: "toBeDefined",
      rationale: "the first store product has at least one purchasable variant",
    },
  },

  // case "inventoryItemId"
  // Admin-only resource (no store analog). Order by NEWEST: the only consumer,
  // `POST …/location-levels`, runs in a flow that just created a product, whose
  // inventory item is UNSTOCKED (location_levels: []). An arbitrary
  // `inventory_items[0]` is often an already-stocked seed item → the create
  // 400s ("Inventory level … already exists"). The newest item is the one the
  // product-create step just made — unstocked, so the level create succeeds.
  // VERIFY: list is non-empty in the seeded backend.
  {
    key: { entity: "inventoryItem", state: "unstocked" },
    auth: ADMIN,
    provenance: "deterministic",
    steps: [{ bindTo: "inventoryItemId", method: "GET", endpoint: "/admin/inventory-items?order=-created_at", extract: "inventory_items[0].id" }],
    oracle: {
      endpoint: "/admin/inventory-items?order=-created_at",
      path: "inventory_items[0].id",
      matcher: "toBeDefined",
      rationale: "list is non-empty in the seeded backend",
    },
  },

  // case "returnId"
  // Admin-only resource. // VERIFY: a return must already exist in the seeded
  // backend for the lifecycle steps to bind a real id.
  {
    key: { entity: "return", state: "any" },
    auth: ADMIN,
    provenance: "deterministic",
    steps: [{ bindTo: "returnId", method: "GET", endpoint: "/admin/returns", extract: "returns[0].id" }],
    oracle: {
      endpoint: "/admin/returns",
      path: "returns[0].id",
      matcher: "toBeDefined",
      rationale: "a return must already exist in the seeded backend for the lifecycle steps to bind a real id",
    },
  },

  // case "stockLocationId"
  // The `location_id` required by fulfillment/inventory bodies is a stock
  // location id; list them admin-side. // VERIFY: list is non-empty (the seed
  // creates at least one stock location).
  {
    key: { entity: "stockLocation", state: "any" },
    auth: ADMIN,
    provenance: "deterministic",
    steps: [{ bindTo: "stockLocationId", method: "GET", endpoint: "/admin/stock-locations", extract: "stock_locations[0].id" }],
    oracle: {
      endpoint: "/admin/stock-locations",
      path: "stock_locations[0].id",
      matcher: "toBeDefined",
      rationale: "list is non-empty (the seed creates at least one stock location)",
    },
  },

  // case "shippingProfileId"
  // `POST /admin/products` requires a shipping profile. // VERIFY: the seed creates one.
  {
    key: { entity: "shippingProfile", state: "any" },
    auth: ADMIN,
    provenance: "deterministic",
    steps: [{ bindTo: "shippingProfileId", method: "GET", endpoint: "/admin/shipping-profiles", extract: "shipping_profiles[0].id" }],
    oracle: {
      endpoint: "/admin/shipping-profiles",
      path: "shipping_profiles[0].id",
      matcher: "toBeDefined",
      rationale: "the seed creates one",
    },
  },

  // case "salesChannelId"
  // `POST /admin/products` links a sales channel so the variant is purchasable
  // in /store. // VERIFY: the seed has a "Default Sales Channel".
  {
    key: { entity: "salesChannel", state: "any" },
    auth: ADMIN,
    provenance: "deterministic",
    steps: [{ bindTo: "salesChannelId", method: "GET", endpoint: "/admin/sales-channels", extract: "sales_channels[0].id" }],
    oracle: {
      endpoint: "/admin/sales-channels",
      path: "sales_channels[0].id",
      matcher: "toBeDefined",
      rationale: 'the seed has a "Default Sales Channel"',
    },
  },

  // case "orderId" — admin + fulfilledOrder branch.
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
  {
    key: { entity: "order", state: "fulfilled" },
    auth: ADMIN,
    provenance: "deterministic",
    steps: [
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
    ],
    oracle: {
      endpoint: ADMIN_PENDING_ORDERS_WITH_ITEMS,
      path: "orders[1].id",
      matcher: "toBeDefined",
      rationale: "a distinct (orders[1]) pending order with line items exists to fulfill before the return begins",
    },
  },

  // case "orderId" — admin + cancel flow (OLDEST cancelable order, fromEnd:true).
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
  //
  // When the consuming flow CANCELS the order, pick from the OLD end of the
  // cancelable set. Cancel and fulfillment both want a pending, uncanceled,
  // unfulfilled order, but only the newest orders still hold a stock
  // reservation (fulfillment 400s "No stock reservation found" without one). So
  // fulfillment keeps the newest match and cancel yields it, taking the oldest —
  // cancel has no reservation requirement, so an older order cancels fine.
  {
    key: { entity: "order", state: "cancelable" },
    auth: ADMIN,
    provenance: "deterministic",
    steps: [
      {
        bindTo: "orderId",
        method: "GET",
        endpoint: "/admin/orders?status[]=pending&order=-created_at&fields=id,status,canceled_at,*fulfillments",
        extract: "",
        select: {
          collection: "orders",
          predicate: "!it.canceled_at && (it.fulfillments?.length ?? 0) === 0",
          field: "id",
          fromEnd: true,
        },
      },
    ],
    oracle: {
      endpoint: "/admin/orders?status[]=pending&order=-created_at&fields=id,status,canceled_at,*fulfillments",
      path: "orders.length",
      matcher: "toBeGreaterThan",
      expected: 0,
      rationale: "at least one uncanceled, unfulfilled pending order exists to cancel (oldest, to keep the reservation-bearing newest for fulfillment)",
    },
  },

  // case "orderId" — admin, non-cancel, non-fulfilled branch (NEWEST cancelable,
  // fromEnd:false). Same recipe as `order@cancelable`; differs ONLY in `fromEnd`
  // so the reservation-bearing newest match is kept for the fulfillment flow (see
  // the cancelable comment above about stock reservations).
  {
    key: { entity: "order", state: "cancelable-newest" },
    auth: ADMIN,
    provenance: "deterministic",
    steps: [
      {
        bindTo: "orderId",
        method: "GET",
        endpoint: "/admin/orders?status[]=pending&order=-created_at&fields=id,status,canceled_at,*fulfillments",
        extract: "",
        select: {
          collection: "orders",
          predicate: "!it.canceled_at && (it.fulfillments?.length ?? 0) === 0",
          field: "id",
          fromEnd: false,
        },
      },
    ],
    oracle: {
      endpoint: "/admin/orders?status[]=pending&order=-created_at&fields=id,status,canceled_at,*fulfillments",
      path: "orders.length",
      matcher: "toBeGreaterThan",
      expected: 0,
      rationale: "at least one uncanceled, unfulfilled pending order exists (newest kept, as it still holds a stock reservation fulfillment needs)",
    },
  },

  // case "orderId" — store branch (non-admin).
  {
    key: { entity: "order", state: "any" },
    auth: "any",
    provenance: "deterministic",
    steps: [{ bindTo: "orderId", method: "GET", endpoint: "/store/orders", extract: "orders[0].id" }],
    oracle: {
      endpoint: "/store/orders",
      path: "orders[0].id",
      matcher: "toBeDefined",
      rationale: "the authenticated customer has at least one order",
    },
  },

  // case "cartId"
  {
    key: { entity: "cart", state: "seeded" },
    auth: "any",
    provenance: "deterministic",
    steps: CART_SEEDED_STEPS,
    oracle: {
      endpoint: "/store/carts/{cartId}/line-items",
      path: "cart.items.length",
      matcher: "toBeGreaterThan",
      expected: 0,
      rationale: "the bootstrapped cart is non-empty (one in-stock line item seeded) so it is completable",
    },
  },

  // case "lineItemId"
  // A cart line-item update needs a line item id even when no prior add step
  // captured one. Bootstrap a cart (the cartId chain seeds one
  // in-stock line item), then read it back off the cart. The cart chain's
  // bindTos are skipped by `ensure` if cartId was already resolved earlier.
  {
    key: { entity: "lineItem", state: "any" },
    auth: "any",
    provenance: "deterministic",
    steps: [
      ...CART_SEEDED_STEPS,
      { bindTo: "lineItemId", method: "GET", endpoint: "/store/carts/{cartId}", extract: "cart.items[0].id" },
    ],
    oracle: {
      endpoint: "/store/carts/{cartId}",
      path: "cart.items[0].id",
      matcher: "toBeDefined",
      rationale: "the seeded cart exposes a readable line item id",
    },
  },

  // case "paymentCollectionId"
  // The cart need only exist (no line items required to open a payment
  // collection), so the standard `regions -> carts` bootstrap suffices.
  {
    key: { entity: "paymentCollection", state: "any" },
    auth: "any",
    provenance: "deterministic",
    steps: [
      ...CART_SEEDED_STEPS,
      {
        bindTo: "paymentCollectionId",
        method: "POST",
        endpoint: "/store/payment-collections",
        extract: "payment_collection.id",
        body: { cart_id: { kind: "runtime", ref: "cartId" } },
      },
    ],
    oracle: {
      endpoint: "/store/payment-collections",
      path: "payment_collection.id",
      matcher: "toBeDefined",
      rationale: "a payment collection opens on the bootstrapped cart",
    },
  },

  // case "paymentProviderId"
  // Payment providers are scoped to a region; the listing endpoint requires
  // `region_id` as a query param.
  {
    key: { entity: "paymentProvider", state: "any" },
    auth: "any",
    provenance: "deterministic",
    steps: [
      { bindTo: "regionId", method: "GET", endpoint: "/store/regions", extract: "regions[0].id" },
      {
        bindTo: "paymentProviderId",
        method: "GET",
        endpoint: "/store/payment-providers",
        extract: "payment_providers[0].id",
        query: { region_id: { kind: "runtime", ref: "regionId" } },
      },
    ],
    oracle: {
      endpoint: "/store/payment-providers",
      path: "payment_providers[0].id",
      matcher: "toBeDefined",
      rationale: "the region exposes at least one payment provider",
    },
  },

  // case "shippingOptionId"
  // Shipping options are computed per cart; the listing requires `cart_id`.
  // // VERIFY: an item-less cart may return no options (shipping_options[0]
  // undefined) — a shipping-methods step that needs this id then fails its own
  // status assertion cleanly rather than skipping.
  {
    key: { entity: "shippingOption", state: "any" },
    auth: "any",
    provenance: "deterministic",
    steps: [
      ...CART_SEEDED_STEPS,
      {
        bindTo: "shippingOptionId",
        method: "GET",
        endpoint: "/store/shipping-options",
        extract: "shipping_options[0].id",
        query: { cart_id: { kind: "runtime", ref: "cartId" } },
      },
    ],
    oracle: {
      endpoint: "/store/shipping-options",
      path: "shipping_options[0].id",
      matcher: "toBeDefined",
      rationale: "an item-less cart may return no options — the consuming shipping-methods step then fails its own status assertion cleanly rather than skipping",
    },
  },
];

// ---------------------------------------------------------------------------
// Retrieval.
// ---------------------------------------------------------------------------

/** Look up a skill by entity+state, disambiguating by auth (exact match wins,
 * then an `"any"` fallback). Returns null when no skill is registered. */
function findSkill(entity: string, state: string, auth: AuthRequirement): Skill | null {
  const matches = SKILLS.filter((s) => s.key.entity === entity && s.key.state === state);
  if (matches.length === 0) return null;
  return matches.find((s) => s.auth === auth) ?? matches.find((s) => s.auth === "any") ?? matches[0];
}

/**
 * The retriever: the ordered ResolveStep chain that arranges `entity` into
 * `state` for the given auth context, or null when no such skill exists. Logs a
 * one-time warning (never throws, never blocks) when the chosen skill is not
 * marked verified in the skills artifact.
 */
export function resolveSkill(entity: string, state: string, auth: AuthRequirement): ResolveStep[] | null {
  const skill = findSkill(entity, state, auth);
  if (!skill) return null;
  warnIfUnverified(skill);
  return skill.steps;
}

/**
 * Compatibility shim reproducing the old `standaloneResolverFor(varName, auth,
 * fulfilledOrder, cancelFlow)` behavior 1:1. Derives the SkillKey from the same
 * inputs, then defers to resolveSkill. The `orderId` overload (fulfilledOrder /
 * cancelFlow booleans) fans out to the three explicit order states.
 */
export function resolveSkillForVar(
  varName: string,
  auth: AuthRequirement,
  // When the consuming flow CANCELS the order, pick from the OLD end of the
  // cancelable set (see `order@cancelable`).
  fulfilledOrder = false,
  cancelFlow = false
): ResolveStep[] | null {
  const key = skillKeyForVar(varName, auth, fulfilledOrder, cancelFlow);
  if (!key) return null;
  return resolveSkill(key.entity, key.state, auth);
}

/** The exact `(varName, auth, fulfilledOrder, cancelFlow)` -> SkillKey mapping
 * the old switch encoded. Kept separate so it can be unit-tested against the
 * legacy behavior. */
export function skillKeyForVar(
  varName: string,
  auth: AuthRequirement,
  fulfilledOrder: boolean,
  cancelFlow: boolean
): SkillKey | null {
  switch (varName) {
    case "regionId":
      return { entity: "region", state: "any" };
    case "productId":
      return { entity: "product", state: "any" };
    case "variantId":
      return { entity: "variant", state: "any" };
    case "inventoryItemId":
      return { entity: "inventoryItem", state: "unstocked" };
    case "returnId":
      return { entity: "return", state: "any" };
    case "stockLocationId":
      return { entity: "stockLocation", state: "any" };
    case "shippingProfileId":
      return { entity: "shippingProfile", state: "any" };
    case "salesChannelId":
      return { entity: "salesChannel", state: "any" };
    case "orderId":
      if (auth === ADMIN && fulfilledOrder) return { entity: "order", state: "fulfilled" };
      if (auth === ADMIN) return { entity: "order", state: cancelFlow ? "cancelable" : "cancelable-newest" };
      return { entity: "order", state: "any" };
    case "cartId":
      return { entity: "cart", state: "seeded" };
    case "lineItemId":
      return { entity: "lineItem", state: "any" };
    case "paymentCollectionId":
      return { entity: "paymentCollection", state: "any" };
    case "paymentProviderId":
      return { entity: "paymentProvider", state: "any" };
    case "shippingOptionId":
      return { entity: "shippingOption", state: "any" };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Verification artifact (mirrors invariants.json / INVARIANTS_ARTIFACT).
// ---------------------------------------------------------------------------

export interface SkillRecord {
  entity: string;
  state: string;
  auth: Skill["auth"];
  provenance: Skill["provenance"];
  /** The oracle checked at verify time (audit trail). */
  oracle: SkillOracle;
  /** True once the oracle HELD against the live known-good backend. */
  verified: boolean;
  /** When the oracle was last checked (honest signal a real run produced this). */
  verified_at?: string;
}

export interface SkillsArtifact {
  generated_at: string;
  /** Keyed by skillId (entity@state#auth). */
  skills: Record<string, SkillRecord>;
}

const EMPTY_SKILLS_ARTIFACT: SkillsArtifact = { generated_at: "", skills: {} };

/** Load the skills artifact, or an empty one when absent/malformed (never throws). */
export function loadSkills(path: string = SKILLS_ARTIFACT): SkillsArtifact {
  if (!existsSync(path)) return EMPTY_SKILLS_ARTIFACT;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SkillsArtifact;
    if (typeof parsed !== "object" || parsed === null || typeof parsed.skills !== "object") {
      return EMPTY_SKILLS_ARTIFACT;
    }
    return parsed;
  } catch {
    return EMPTY_SKILLS_ARTIFACT;
  }
}

export function saveSkills(artifact: SkillsArtifact, path: string = SKILLS_ARTIFACT): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`);
}

/** A fresh artifact listing every registered skill as `verified:false`. Mirrors
 * the invariants "propose then verify" split: this is the "propose" side. */
export function buildSkillsArtifact(): SkillsArtifact {
  const skills: Record<string, SkillRecord> = {};
  for (const s of SKILLS) {
    skills[skillId(s.key, s.auth)] = {
      entity: s.key.entity,
      state: s.key.state,
      auth: s.auth,
      provenance: s.provenance,
      oracle: s.oracle,
      verified: false,
    };
  }
  return { generated_at: new Date().toISOString(), skills };
}

/** Evaluate a skill's oracle against a captured response body, REUSING the
 * invariants evaluator so the answer matches the invariants layer exactly. */
export function evaluateSkillOracle(oracle: SkillOracle, body: unknown): boolean {
  const inv: FieldInvariant = {
    kind: "field",
    stepTitle: oracle.endpoint,
    rationale: oracle.rationale,
    source: "deterministic",
    verified: false,
    path: oracle.path,
    matcher: oracle.matcher,
    expected: oracle.expected,
  };
  return evaluateInvariant(body, inv).pass;
}

/**
 * The anti-hallucination bake gate for skills (the "verify" side). Replays each
 * skill's oracle against the captured response body of its binding endpoint from
 * a known-good run (`bodiesByEndpoint`, keyed by SkillOracle.endpoint). A skill
 * whose body is present AND whose oracle HOLDS flips to `verified:true`; the rest
 * stay `verified:false`. Wiring a live HTTP capture is the caller's job (a future
 * CLI can feed a normalized run here, exactly as the invariants CLI does).
 */
export function verifySkills(
  bodiesByEndpoint: Map<string, unknown>,
  base: SkillsArtifact = buildSkillsArtifact()
): SkillsArtifact {
  const now = new Date().toISOString();
  const skills: Record<string, SkillRecord> = {};
  for (const [id, rec] of Object.entries(base.skills)) {
    if (!bodiesByEndpoint.has(rec.oracle.endpoint)) {
      skills[id] = { ...rec, verified: false };
      continue;
    }
    const pass = evaluateSkillOracle(rec.oracle, bodiesByEndpoint.get(rec.oracle.endpoint));
    skills[id] = { ...rec, verified: pass, verified_at: now };
  }
  return { generated_at: now, skills };
}

// One-time unverified-skill warning (stderr only — never alters emitted specs).
let artifactCache: SkillsArtifact | null | undefined;
const warned = new Set<string>();

function warnIfUnverified(skill: Skill): void {
  if (artifactCache === undefined) {
    artifactCache = existsSync(SKILLS_ARTIFACT) ? loadSkills() : null;
  }
  const id = skillId(skill.key, skill.auth);
  const rec = artifactCache?.skills[id];
  if ((!rec || !rec.verified) && !warned.has(id)) {
    warned.add(id);
    console.warn(
      `[skills] using UNVERIFIED skill ${id} — its oracle has not been checked against the live backend; generation continues`
    );
  }
}
