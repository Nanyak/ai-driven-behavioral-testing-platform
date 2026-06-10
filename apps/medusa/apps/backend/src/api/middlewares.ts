import { existsSync, mkdirSync, appendFile } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import {
  defineMiddlewares,
  type MedusaNextFunction,
  type MedusaRequest,
  type MedusaResponse
} from "@medusajs/framework/http"

const SENSITIVE_KEY_PATTERN =
  /password|passwd|pwd|token|secret|authorization|cookie|api[-_]?key|session|csrf|jwt|credential|phone|email|address|pan|card|payment|account|paper|document|ssn|tin/i
const SAFE_HEADER_NAMES = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "content-length",
  "content-type",
  "host",
  "origin",
  "referer",
  "user-agent",
  "x-forwarded-for",
  "x-real-ip",
  "x-request-id",
  "x-session-id",
  "x-trace-id"
])
const MAX_STRING_LENGTH = 500
const MAX_ARRAY_ITEMS = 10
const MAX_OBJECT_KEYS = 30
const MAX_DEPTH = 4
const BODY_CAPTURE_DISABLED = "[body_capture_disabled]"
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

function getLogLevel(): string {
  return process.env.LOG_LEVEL || "info"
}

function getContentLength(value: string | undefined): number | null {
  if (!value) {
    return null
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function getRemoteIp(req: MedusaRequest): string | null {
  return (
    getHeader(req, "x-real-ip") ||
    firstHeaderValue(getHeader(req, "x-forwarded-for")?.split(",").map((ip) => ip.trim())) ||
    req.ip ||
    req.socket?.remoteAddress ||
    null
  )
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

function getSafeHeaders(req: MedusaRequest): Record<string, unknown> {
  return Object.entries(req.headers).reduce<Record<string, unknown>>(
    (headers, [rawName, rawValue]) => {
      const name = rawName.toLowerCase()

      if (SENSITIVE_KEY_PATTERN.test(name)) {
        headers[name] = rawValue ? MASKED_VALUE : rawValue
        return headers
      }

      if (!SAFE_HEADER_NAMES.has(name)) {
        return headers
      }

      headers[name] = reduceValue(rawValue)
      return headers
    },
    {}
  )
}

function getQueryParams(req: MedusaRequest, rawEndpoint: string): Record<string, unknown> {
  const query = (req as MedusaRequest & { query?: Record<string, unknown> }).query
  if (query && Object.keys(query).length > 0) {
    return reduceValue(query) as Record<string, unknown>
  }

  const questionMarkIndex = rawEndpoint.indexOf("?")
  if (questionMarkIndex === -1) {
    return {}
  }

  const params = new URLSearchParams(rawEndpoint.slice(questionMarkIndex + 1))
  const parsed: Record<string, string | string[]> = {}

  for (const [key, value] of params.entries()) {
    const maskedValue = maskValueByKey(key, value)
    const safeValue = String(maskedValue ?? value)

    if (parsed[key]) {
      parsed[key] = Array.isArray(parsed[key])
        ? [...parsed[key], safeValue]
        : [parsed[key], safeValue]
    } else {
      parsed[key] = safeValue
    }
  }

  return reduceValue(parsed) as Record<string, unknown>
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
  let responseSizeBytes: number | null = null

  res.setHeader("x-trace-id", traceId)

  const response = res as MedusaResponse & {
    json: ResponseMethod
    send: ResponseMethod
  }
  const originalJson = response.json.bind(res)
  const originalSend = response.send.bind(res)

  response.json = (...args: unknown[]) => {
    responseBody = args[0]
    responseSizeBytes = Buffer.byteLength(JSON.stringify(args[0] ?? ""), "utf8")
    return originalJson(...args)
  }

  response.send = (...args: unknown[]) => {
    responseBody = args[0]
    responseSizeBytes = Buffer.isBuffer(args[0])
      ? args[0].length
      : Buffer.byteLength(String(args[0] ?? ""), "utf8")
    return originalSend(...args)
  }

  res.once("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startTime) / 1_000_000
    const auth = getAuthContext(req)
    const captureBodies = getBodyCaptureEnabled()
    const requestBody = (req as MedusaRequest & { body?: unknown }).body

    writeJsonLine({
      event_type: "http_request_completed",
      source: "medusa",
      level: getLogLevel(),
      timestamp,
      trace_id: traceId,
      session_id: getSessionId(req) ?? null,
      persona: getHeader(req, "x-persona") || getHeader(req, "x-behavior-persona") || null,
      user_role: auth.user_role ?? null,
      user_id: auth.user_id ?? null,
      method: req.method,
      raw_endpoint: rawEndpoint,
      normalized_endpoint: normalizeEndpoint(rawEndpoint),
      query_params: getQueryParams(req, rawEndpoint),
      request_headers: getSafeHeaders(req),
      remote_ip: getRemoteIp(req),
      user_agent: getHeader(req, "user-agent") || null,
      request_content_length: getContentLength(getHeader(req, "content-length")),
      request_body_capture: captureBodies ? "captured" : "disabled",
      request_payload: captureBodies ? reduceValue(requestBody) ?? null : BODY_CAPTURE_DISABLED,
      response_code: res.statusCode,
      response_content_length:
        getContentLength(String(res.getHeader("content-length") ?? "")) ?? responseSizeBytes,
      response_body_capture: captureBodies ? "captured" : "disabled",
      response_body: captureBodies
        ? reduceValue(tryParseResponseBody(responseBody)) ?? null
        : BODY_CAPTURE_DISABLED,
      duration_ms: Math.round(durationMs * 100) / 100
    })
  })

  next()
}

export default defineMiddlewares({
  routes: [
    {
      matcher: "/*",
      middlewares: [structuredRequestLogger]
    }
  ]
})
