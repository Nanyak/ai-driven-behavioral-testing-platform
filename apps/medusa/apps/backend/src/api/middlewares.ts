import { existsSync, mkdirSync, appendFile } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import {
  defineMiddlewares,
  type MedusaNextFunction,
  type MedusaRequest,
  type MedusaResponse
} from "@medusajs/framework/http"
import {
  GATE_MATCHERS,
  GATE_METHODS,
  GATE_UNAUTHORIZED_BODY,
  GATE_UNAUTHORIZED_STATUS
} from "./gate-contract"

const SENSITIVE_KEY_PATTERN =
  /password|passwd|pwd|token|secret|authorization|cookie|api[-_]?key|session|csrf|jwt|credential|phone|email|address|pan|card|payment|account|paper|document|ssn|tin/i
const MAX_STRING_LENGTH = 500
const MAX_ARRAY_ITEMS = 10
const MAX_OBJECT_KEYS = 30
const MAX_DEPTH = 4
const MASKED_VALUE = "[masked]"
const ensuredLogDirectories = new Set<string>()

type HeaderValue = string | string[] | undefined
type ResponseMethod = (...args: unknown[]) => unknown

function firstHeaderValue(value: HeaderValue): string | undefined {
  if (Array.isArray(value)) {
    return value[0]
  }

  return value
}

function getHeader(req: MedusaRequest, name: string): string | undefined {
  return firstHeaderValue(req.headers[name.toLowerCase()] as HeaderValue)
}

function getBodyCaptureEnabled(): boolean {
  return process.env.LOG_CAPTURE_BODIES === "true"
}

function getTraceId(req: MedusaRequest): string {
  const explicitTraceId = getHeader(req, "x-trace-id") || getHeader(req, "trace-id")
  if (explicitTraceId) {
    return explicitTraceId
  }

  const traceparent = getHeader(req, "traceparent")
  const parsedTraceparent = traceparent?.match(
    /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/i
  )

  return parsedTraceparent?.[1] || randomUUID()
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) {
    return {}
  }

  return cookieHeader.split(";").reduce<Record<string, string>>((cookies, part) => {
    const separator = part.indexOf("=")
    if (separator === -1) {
      return cookies
    }

    const key = part.slice(0, separator).trim()
    const value = part.slice(separator + 1).trim()
    cookies[key] = decodeURIComponent(value)
    return cookies
  }, {})
}

function getSessionId(req: MedusaRequest): string | undefined {
  const headerValue =
    getHeader(req, "x-session-id") ||
    getHeader(req, "x-behavior-session-id") ||
    getHeader(req, "session-id")

  if (headerValue) {
    return headerValue
  }

  const reqWithCookies = req as MedusaRequest & {
    cookies?: Record<string, string>
    signedCookies?: Record<string, string>
  }
  const parsedCookies = {
    ...parseCookies(getHeader(req, "cookie")),
    ...(reqWithCookies.cookies ?? {}),
    ...(reqWithCookies.signedCookies ?? {})
  }

  return (
    parsedCookies.session_id ||
    parsedCookies.behavior_session_id ||
    parsedCookies.medusa_session
  )
}

function normalizeEndpoint(rawEndpoint: string): string {
  const pathname = rawEndpoint.split("?")[0] || "/"

  return pathname
    .split("/")
    .map((segment) => {
      if (!segment) {
        return segment
      }

      if (/^[0-9]+$/.test(segment)) {
        return ":number"
      }

      if (/^[0-9a-f]{24,}$/i.test(segment)) {
        return ":hex_id"
      }

      if (
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          segment
        )
      ) {
        return ":uuid"
      }

      if (/^[a-z]+_[a-zA-Z0-9]+$/.test(segment)) {
        return `:${segment.split("_")[0]}_id`
      }

      return segment
    })
    .join("/")
}

function truncateString(value: string): string {
  if (value.length <= MAX_STRING_LENGTH) {
    return value
  }

  return `${value.slice(0, MAX_STRING_LENGTH)}...[truncated]`
}

function maskValueByKey(key: string, value: unknown): unknown {
  if (!SENSITIVE_KEY_PATTERN.test(key)) {
    return undefined
  }

  if (value === null || value === undefined || value === "") {
    return value
  }

  return MASKED_VALUE
}

function reduceValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) {
    return value
  }

  if (typeof value === "string") {
    return truncateString(value)
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value
  }

  if (Buffer.isBuffer(value)) {
    return `[buffer:${value.length}]`
  }

  if (depth >= MAX_DEPTH) {
    if (Array.isArray(value)) {
      return `[array:${value.length}]`
    }

    if (typeof value === "object") {
      return "[object]"
    }
  }

  if (Array.isArray(value)) {
    const reducedItems = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => reduceValue(item, depth + 1))

    if (value.length > MAX_ARRAY_ITEMS) {
      reducedItems.push(`[${value.length - MAX_ARRAY_ITEMS} more items]`)
    }

    return reducedItems
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
    const reducedEntries = entries.slice(0, MAX_OBJECT_KEYS).map(([key, entryValue]) => {
      const maskedValue = maskValueByKey(key, entryValue)
      if (maskedValue !== undefined) {
        return [key, maskedValue]
      }

      return [key, reduceValue(entryValue, depth + 1)]
    })

    if (entries.length > MAX_OBJECT_KEYS) {
      reducedEntries.push(["__truncated_keys", entries.length - MAX_OBJECT_KEYS])
    }

    return Object.fromEntries(reducedEntries)
  }

  return String(value)
}

function tryParseResponseBody(body: unknown): unknown {
  if (typeof body !== "string") {
    return body
  }

  const trimmedBody = body.trim()
  if (!trimmedBody || !/^[{[]/.test(trimmedBody)) {
    return body
  }

  try {
    return JSON.parse(trimmedBody)
  } catch {
    return body
  }
}

function findWorkspaceRoot(startDirectory: string): string {
  let currentDirectory = resolve(startDirectory)

  while (true) {
    if (existsSync(join(currentDirectory, "context", "checklist.md"))) {
      return currentDirectory
    }

    const parentDirectory = dirname(currentDirectory)
    if (parentDirectory === currentDirectory) {
      return startDirectory
    }

    currentDirectory = parentDirectory
  }
}

function resolveLogOutputPath(): string {
  const configuredPath = process.env.LOG_OUTPUT_PATH || "logs/medusa-json.log"

  if (isAbsolute(configuredPath)) {
    return configuredPath
  }

  return resolve(findWorkspaceRoot(process.cwd()), configuredPath)
}

function writeJsonLine(event: Record<string, unknown>): void {
  const line = JSON.stringify(event)
  const logPath = resolveLogOutputPath()

  try {
    console.log(line)
    const logDirectory = dirname(logPath)
    if (!ensuredLogDirectories.has(logDirectory)) {
      mkdirSync(logDirectory, { recursive: true })
      ensuredLogDirectories.add(logDirectory)
    }

    appendFile(logPath, `${line}\n`, "utf8", (error) => {
      if (error) {
        console.error(
          JSON.stringify({
            source: "medusa",
            level: "error",
            event_type: "log_write_failed",
            message: error.message
          })
        )
      }
    })
  } catch (error) {
    console.error(
      JSON.stringify({
        source: "medusa",
        level: "error",
        event_type: "log_write_failed",
        message: error instanceof Error ? error.message : String(error)
      })
    )
  }
}

function getAuthContext(req: MedusaRequest): {
  user_role?: string
  user_id?: string
} {
  const requestWithAuth = req as MedusaRequest & {
    auth_context?: {
      actor_id?: string
      actor_type?: string
      auth_identity_id?: string
      app_metadata?: Record<string, unknown>
    }
    user?: {
      id?: string
      role?: string
      type?: string
    }
  }
  const authContext = requestWithAuth.auth_context
  const user = requestWithAuth.user
  const metadata = authContext?.app_metadata

  return {
    user_role:
      authContext?.actor_type ||
      user?.role ||
      user?.type ||
      (typeof metadata?.role === "string" ? metadata.role : undefined),
    user_id:
      authContext?.actor_id ||
      authContext?.auth_identity_id ||
      user?.id ||
      (typeof metadata?.user_id === "string" ? metadata.user_id : undefined) ||
      (typeof metadata?.customer_id === "string" ? metadata.customer_id : undefined)
  }
}

// --- Production log shaping (hybrid: semantic event + route, bodies-off) ---
//
// Real production systems emit business-event logs with a logical service tag
// and no request/response bodies (cost + PII). We simulate that here so the
// pipeline's source looks like production rather than dev access logs. The
// route (method + normalized endpoint) is retained alongside the derived
// `event` so downstream sequence mining keeps working.

const VERB_BY_METHOD: Record<string, string> = {
  GET: "viewed",
  POST: "created",
  PUT: "updated",
  PATCH: "updated",
  DELETE: "deleted"
}

const EVENT_MAP: Record<string, string> = {
  "GET /store/regions": "regions_listed",
  "GET /store/products": "products_listed",
  "GET /store/products/{id}": "product_viewed",
  "POST /store/carts": "cart_created",
  "GET /store/carts/{id}": "cart_viewed",
  "POST /store/carts/{id}": "cart_updated",
  "POST /store/carts/{id}/line-items": "cart_item_added",
  "POST /store/carts/{id}/line-items/{id}": "cart_item_updated",
  "DELETE /store/carts/{id}/line-items/{id}": "cart_item_removed",
  "GET /store/shipping-options": "shipping_options_listed",
  "POST /store/carts/{id}/shipping-methods": "shipping_method_selected",
  "GET /store/payment-providers": "payment_providers_listed",
  "POST /store/payment-collections": "payment_collection_created",
  "POST /store/payment-collections/{id}/payment-sessions": "payment_session_created",
  "POST /store/carts/{id}/complete": "checkout_completed",
  "GET /store/orders": "orders_listed",
  "GET /store/orders/{id}": "order_viewed",
  "POST /store/customers": "customer_created",
  "GET /store/customers/me": "customer_profile_viewed",
  "POST /auth/customer/emailpass/register": "customer_registered",
  "POST /auth/customer/emailpass": "customer_logged_in",
  "POST /auth/user/emailpass": "admin_logged_in",
  "GET /admin/products": "admin_products_listed",
  "GET /admin/products/{id}": "admin_product_viewed",
  "POST /admin/products": "admin_product_created",
  "POST /admin/products/{id}": "admin_product_updated",
  "GET /admin/orders": "admin_orders_listed",
  "GET /admin/customers": "admin_customers_listed",
  "GET /health": "health_checked"
}

/** Collapse normalizer placeholders (e.g. `:cart_id`) to a uniform `{id}`. */
function endpointTemplate(normalized: string): string {
  return normalized.replace(/\/:[^/]+/g, "/{id}")
}

function deriveLevel(status: number): string {
  if (status >= 500) return "ERROR"
  if (status >= 400) return "WARN"
  return "INFO"
}

function getEnvironment(): string {
  return process.env.LOG_ENVIRONMENT || "production"
}

/** Logical bounded-context name for a monolith route (looks like a service estate). */
function deriveService(template: string): string {
  if (template.startsWith("/admin")) return "admin-service"
  if (template.startsWith("/auth")) return "auth-service"
  if (template.startsWith("/store/customers")) return "customer-service"
  if (
    template.startsWith("/store/products") ||
    template.startsWith("/store/regions") ||
    template.startsWith("/store/collections") ||
    template.startsWith("/store/product-categories")
  ) {
    return "product-catalog"
  }
  if (template.startsWith("/store/carts")) return "cart-service"
  if (template.startsWith("/store/shipping-options") || template.startsWith("/store/payment")) {
    return "checkout-service"
  }
  if (template.startsWith("/store/orders")) return "order-service"
  if (template.startsWith("/health")) return "platform-health"
  if (template.startsWith("/store")) return "store-gateway"
  return "medusa"
}

/** Semantic business-event name for a route; falls back to `<resource>_<verb>`. */
function deriveEvent(method: string, template: string): string {
  const mapped = EVENT_MAP[`${method} ${template}`]
  if (mapped) {
    return mapped
  }

  const parts = template.split("/").filter(Boolean)
  let resource = "request"
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i] !== "{id}") {
      resource = parts[i]
      break
    }
  }
  resource = resource.replace(/[^a-zA-Z0-9]+/g, "_")
  return `${resource}_${VERB_BY_METHOD[method] || "called"}`
}

async function structuredRequestLogger(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  const startTime = process.hrtime.bigint()
  const timestamp = new Date().toISOString()
  const rawEndpoint = req.originalUrl || req.url || "/"
  const traceId = getTraceId(req)
  let responseBody: unknown

  res.setHeader("x-trace-id", traceId)

  const response = res as MedusaResponse & {
    json: ResponseMethod
    send: ResponseMethod
  }
  const originalJson = response.json.bind(res)
  const originalSend = response.send.bind(res)

  response.json = (...args: unknown[]) => {
    responseBody = args[0]
    return originalJson(...args)
  }

  response.send = (...args: unknown[]) => {
    responseBody = args[0]
    return originalSend(...args)
  }

  res.once("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startTime) / 1_000_000
    const auth = getAuthContext(req)
    const captureBodies = getBodyCaptureEnabled()
    const requestBody = (req as MedusaRequest & { body?: unknown }).body
    const template = endpointTemplate(normalizeEndpoint(rawEndpoint))

    writeJsonLine({
      timestamp,
      level: deriveLevel(res.statusCode),
      service: deriveService(template),
      environment: getEnvironment(),
      request_id: randomUUID(),
      trace_id: traceId,
      session_id: getSessionId(req) ?? null,
      user_id: auth.user_id ?? null,
      user_role: auth.user_role ?? null,
      event: deriveEvent(req.method, template),
      method: req.method,
      endpoint: template,
      status: res.statusCode,
      duration_ms: Math.round(durationMs * 100) / 100,
      source: "medusa",
      // Production runs bodies-off (cost + PII); the OpenAPI spec is the golden
      // oracle (ADR 0001). Bodies are an optional dev enrichment only.
      ...(captureBodies
        ? {
            request_payload: reduceValue(requestBody) ?? null,
            response_body: reduceValue(tryParseResponseBody(responseBody)) ?? null
          }
        : {})
    })
  })

  next()
}

/**
 * Require an authenticated customer JWT for all cart and checkout mutations.
 * The storefront gates "Add to cart" behind sign-in, but that is a UI-only gate —
 * anyone with curl can hit POST /store/carts directly. This middleware closes
 * that gap at the API layer.
 *
 * Covered: cart creation, line-item add/update/remove, shipping, payment
 * collection, and checkout completion. GET requests are intentionally left open
 * so order-confirmation pages can load a cart without re-authenticating.
 */
function requireCustomerAuth(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  const authContext = (req as MedusaRequest & {
    auth_context?: { actor_type?: string }
  }).auth_context

  if (authContext?.actor_type === "customer") {
    return next()
  }

  res.status(GATE_UNAUTHORIZED_STATUS).json(GATE_UNAUTHORIZED_BODY)
}

/**
 * Phase 12 regression-demo fault injector (reversible, OFF by default).
 *
 * Does nothing unless `REGRESSION_DEMO` is set, so production/CI behavior is
 * unchanged unless the demo explicitly opts in (docs/phase-12-implementation-plan.md
 * §"Reversible injection"). Scenario A (response-code regression): when
 * `REGRESSION_DEMO=carts_complete_500`, make checkout completion return 500
 * instead of its documented 200, so the frozen golden baseline flags a
 * regression on `POST /store/carts/{id}/complete`. Registered AFTER
 * `requireCustomerAuth` so only an authenticated customer reaches the fault —
 * the failure is a behavioral regression, not an auth rejection. Unset the env
 * var to flip the report red -> green live, no redeploy.
 */
function regressionDemoFault(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  if (process.env.REGRESSION_DEMO === "carts_complete_500" && req.path.endsWith("/complete")) {
    res.status(500).json({
      type: "regression_demo",
      message: "Injected fault (Phase 12): POST /store/carts/{id}/complete forced to 500."
    })
    return
  }

  next()
}

export default defineMiddlewares({
  routes: [
    {
      matcher: "/*",
      middlewares: [structuredRequestLogger]
    },
    // Match string (not RegExp) matchers: Medusa's middleware loader coerces
    // every matcher with String(matcher), so a RegExp becomes a literal path
    // string Express can never match and the gate silently never runs. The
    // methods-filtered path registers via app.post(matcher), a full-path match,
    // so the trailing `*` is required to also cover sub-paths (/line-items,
    // /shipping-methods, /complete, /payment-sessions).
    //
    // Matchers/methods/envelope come from gate-contract.ts (ADR 0004 decision
    // #3) — the same module build-oas.ts imports to document this gate in the
    // augmented OpenAPI spec, so enforcement and documentation cannot drift.
    {
      matcher: GATE_MATCHERS[0],
      method: [...GATE_METHODS],
      middlewares: [requireCustomerAuth]
    },
    {
      matcher: GATE_MATCHERS[1],
      method: [...GATE_METHODS],
      middlewares: [requireCustomerAuth]
    },
    // Phase 12 regression-demo fault injector — OFF unless REGRESSION_DEMO is
    // set. Placed AFTER the gate so it only fires for authenticated customers
    // (a real checkout that now 500s), making the failure a behavioral
    // regression rather than an auth rejection.
    {
      matcher: GATE_MATCHERS[0],
      method: ["POST"],
      middlewares: [regressionDemoFault]
    }
  ]
})
