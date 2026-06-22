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

export type PathPlan = { template: string; params: Record<string, string> };

/** A resolve call emitted BEFORE the step's main request, to populate scope. */
export interface ResolveCall {
  bindTo: string;
  method: string;
  endpoint: string;
  extract: string;
  auth: AuthRequirement;
  /** Inline request body for a bootstrap mutation (e.g. `POST /store/carts` needs `region_id`). */
  body?: SynthesizedBody;
  /** Required query params for a resolving GET (e.g. `GET /store/payment-providers` needs `region_id`). */
  query?: SynthesizedBody;
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
  if (method === "POST" && endpoint === "/store/carts/{id}/line-items") return { lineItemId: "line_item.id" };
  // Checkout reads that produce an id a later mutation needs in its body: the
  // shipping-method step takes `option_id` and the payment-session step takes
  // `provider_id`. Binding them here lets the full checkout chain thread end to
  // end (GET appears before the POST that consumes it in the mined journey).
  if (method === "GET" && endpoint === "/store/shipping-options") return { shippingOptionId: "shipping_options[0].id" };
  if (method === "GET" && endpoint === "/store/payment-providers") return { paymentProviderId: "payment_providers[0].id" };
  if (method === "POST" && endpoint === "/store/payment-collections") return { paymentCollectionId: "payment_collection.id" };
  if (method === "POST" && (endpoint === "/auth/customer/emailpass" || endpoint === "/auth/customer/emailpass/register"))
    return { customerToken: "$raw" };
  if (method === "POST" && endpoint === "/auth/user/emailpass") return { adminToken: "$raw" };
  return {};
}

function scopeVarForParam(param: string, endpoint: string): string {
  if (endpoint.startsWith("/admin/orders")) return "orderId";
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
  body?: SynthesizedBody;
  query?: SynthesizedBody;
};

// Most scope variables resolve via a single GET; `cartId` is a short bootstrap
// chain (`GET /store/regions` -> `POST /store/carts`) since a cart is a
// runtime-created resource, never a literal/seeded id (CLAUDE.md §5).
function standaloneResolverFor(varName: string, auth: AuthRequirement): ResolveStep[] | null {
  switch (varName) {
    case "regionId":
      return [{ bindTo: varName, method: "GET", endpoint: "/store/regions", extract: "regions[0].id" }];
    case "productId":
      return [{ bindTo: varName, method: "GET", endpoint: "/store/products", extract: "products[0].id" }];
    case "variantId":
      return [{ bindTo: varName, method: "GET", endpoint: "/store/products", extract: "products[0].variants[0].id" }];
    case "orderId":
      return auth === ADMIN
        ? [{ bindTo: varName, method: "GET", endpoint: "/admin/orders", extract: "orders[0].id" }]
        : [{ bindTo: varName, method: "GET", endpoint: "/store/orders", extract: "orders[0].id" }];
    case "cartId":
      return [
        { bindTo: "regionId", method: "GET", endpoint: "/store/regions", extract: "regions[0].id" },
        {
          bindTo: varName,
          method: "POST",
          endpoint: "/store/carts",
          extract: "cart.id",
          body: { region_id: { kind: "runtime", ref: "regionId" } },
        },
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
    default:
      return null;
  }
}

function requestSchemaFor(
  specs: OasSpecs,
  method: string,
  endpoint: string
): { doc: OasDocument; schema: OasSchema } | null {
  for (const doc of [specs.store, specs.admin]) {
    const pathItem = doc.paths[endpoint];
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
    .map(([name, child]) => ({ name, required: true, type: leafTypeOf(doc, child) }));
}

const ID_FIELD_TO_SCOPE: Record<string, string> = {
  region_id: "regionId",
  variant_id: "variantId",
  option_id: "shippingOptionId",
  provider_id: "paymentProviderId",
  cart_id: "cartId",
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
    if (field.type === "number") {
      synthesized[field.name] = { kind: "literal", value: 1 };
    } else if (field.type === "boolean") {
      synthesized[field.name] = { kind: "literal", value: true };
    } else if (field.type === "string") {
      synthesized[field.name] = { kind: "literal", value: `test-${field.name}` };
    } else {
      if (edgeOmitOnFailure) continue; // omit: array/object required fields reproduce the same missing-field condition
      return {
        kind: "unresolvable",
        reason: `required field "${field.name}" has no synthesizable literal type ("${field.type}")`,
      };
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

export function buildFlowPlan(
  steps: CandidateStep[],
  specs: OasSpecs,
  flowRequiresAuth: boolean
): FlowPlan {
  const scope = new Set<string>(["publishableKey"]);
  const plans: StepPlan[] = [];
  const errors: string[] = [];

  for (const step of steps) {
    const auth = authFor(step.endpoint, flowRequiresAuth);
    const resolveCalls: ResolveCall[] = [];

    // Ensure a scope variable is available, emitting (chained) resolve calls if
    // not. Returns false when no prior step or standalone GET can produce it.
    const ensure = (varName: string): boolean => {
      if (scope.has(varName)) return true;
      const chain = standaloneResolverFor(varName, auth);
      if (!chain) return false;
      for (const call of chain) {
        if (scope.has(call.bindTo)) continue; // a chained prerequisite already resolved earlier in this flow
        resolveCalls.push({ ...call, auth });
        scope.add(call.bindTo);
      }
      return true;
    };

    const pathParams: Record<string, string> = {};
    let stepFailed = false;

    for (const param of pathParamNames(step.endpoint)) {
      const varName = scopeVarForParam(param, step.endpoint);
      if (ensure(varName)) {
        pathParams[param] = varName;
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

    // A step whose OWN logged expected_status is already a 4xx/5xx reproduces
    // that failure structurally (an omitted OAS-required field) — never invents
    // a new malformation.
    let body: BodyPlan;
    if (step.request_payload !== undefined) {
      body = { kind: "observed", payload: step.request_payload };
    } else {
      body =
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
