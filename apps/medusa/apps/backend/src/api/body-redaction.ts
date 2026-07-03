const MAX_STRING_LENGTH = 500
const MAX_ARRAY_ITEMS = 10
// Large API objects (e.g. a fully-populated Medusa cart has ~48 keys) must be
// logged in full: a truncated body poisons golden capture with a synthetic
// `__truncated_keys` field that no real response ever returns, so every golden
// built from it mismatches the live shape. Keep this above the widest response
// object.
const MAX_OBJECT_KEYS = 100
const MAX_DEPTH = 4

export const MASKED_VALUE = "[masked]"

type ReductionMode = "normal" | "mask-leaves"

const SENSITIVE_SCALAR_TOKENS = new Set([
  "password",
  "passwd",
  "pwd",
  "passcode",
  "token",
  "secret",
  "authorization",
  "cookie",
  "session",
  "csrf",
  "jwt",
  "credential",
  "credentials",
  "email",
  "phone",
  "pan",
  "cvv",
  "cvc",
  "ssn",
  "tin",
  "address"
])

function normalizedKeyParts(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

function hasSingularOrPluralPart(parts: string[], part: string): boolean {
  const plural = part.endsWith("s") ? part : `${part}s`
  return parts.includes(part) || parts.includes(plural)
}

function isSensitiveScalarKey(key: string): boolean {
  const parts = normalizedKeyParts(key)
  const normalized = parts.join("_")

  if (parts.some((part) => SENSITIVE_SCALAR_TOKENS.has(part))) {
    return true
  }

  if (normalized === "api_key") {
    return true
  }

  if (parts.includes("card")) {
    return (
      parts.length === 1 ||
      parts.some((part) =>
        ["number", "pan", "token", "cvv", "cvc", "details", "data", "payload"].includes(part)
      )
    )
  }

  if (parts.includes("account")) {
    return (
      parts.length === 1 ||
      parts.includes("bank") ||
      parts.some((part) => ["number", "details", "data", "payload"].includes(part))
    )
  }

  if (parts.includes("payment")) {
    return parts.some((part) => ["details", "data", "payload", "instrument"].includes(part))
  }

  if (parts.includes("document")) {
    return (
      parts.length === 1 ||
      parts.some((part) =>
        ["number", "payload", "data", "content", "file", "identity", "tax"].includes(part)
      )
    )
  }

  if (parts.includes("paper")) {
    return (
      parts.length === 1 ||
      parts.some((part) => ["payload", "data", "content", "document"].includes(part))
    )
  }

  return false
}

function isSensitiveContainerKey(key: string): boolean {
  const parts = normalizedKeyParts(key)
  const normalized = parts.join("_")

  if (
    hasSingularOrPluralPart(parts, "address") ||
    hasSingularOrPluralPart(parts, "credential") ||
    hasSingularOrPluralPart(parts, "cookie") ||
    hasSingularOrPluralPart(parts, "session")
  ) {
    return true
  }

  if (normalized === "payment" || normalized === "payments") {
    return true
  }
  if (
    hasSingularOrPluralPart(parts, "payment") &&
    parts.some((part) =>
      ["details", "data", "payload", "method", "methods", "instrument", "instruments"].includes(
        part
      )
    )
  ) {
    return true
  }

  if (normalized === "card" || normalized === "cards") {
    return true
  }
  if (
    hasSingularOrPluralPart(parts, "card") &&
    parts.some((part) => ["details", "data", "payload"].includes(part))
  ) {
    return true
  }

  if (normalized === "account" || normalized === "accounts") {
    return true
  }
  if (
    hasSingularOrPluralPart(parts, "account") &&
    (parts.includes("bank") ||
      parts.at(-1) === "account" ||
      parts.at(-1) === "accounts" ||
      parts.some((part) => ["details", "data", "payload"].includes(part)))
  ) {
    return true
  }

  if (normalized === "document" || normalized === "documents") {
    return true
  }
  if (
    hasSingularOrPluralPart(parts, "document") &&
    parts.some((part) =>
      ["payload", "data", "content", "file", "files", "identity", "tax"].includes(part)
    )
  ) {
    return true
  }

  if (normalized === "paper" || normalized === "papers") {
    return true
  }
  return (
    hasSingularOrPluralPart(parts, "paper") &&
    parts.some((part) => ["payload", "data", "content", "document"].includes(part))
  )
}

function truncateString(value: string): string {
  if (value.length <= MAX_STRING_LENGTH) {
    return value
  }

  return `${value.slice(0, MAX_STRING_LENGTH)}...[truncated]`
}

function isStructuredValue(value: unknown): value is object {
  return value !== null && typeof value === "object"
}

function maskSensitiveScalar(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value
  }

  if (typeof value === "number") {
    return 0
  }
  if (typeof value === "boolean") {
    return false
  }
  return MASKED_VALUE
}

/**
 * Produces a bounded, logging-safe representation of a request or response body.
 *
 * A sensitive scalar is replaced directly. A sensitive object or array keeps its
 * keys/collection shape, but every primitive leaf below it is replaced. This
 * retains useful schema evidence without allowing nested values to escape merely
 * because their individual keys (for example `city`) look harmless.
 */
export function reduceValue(
  value: unknown,
  depth = 0,
  maskSensitive = true,
  mode: ReductionMode = "normal"
): unknown {
  if (value === null || value === undefined) {
    return value
  }

  if (mode === "mask-leaves" && !isStructuredValue(value)) {
    return maskSensitiveScalar(value)
  }

  if (typeof value === "string") {
    return truncateString(value)
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value
  }

  if (Buffer.isBuffer(value)) {
    return mode === "mask-leaves" ? MASKED_VALUE : `[buffer:${value.length}]`
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
      .map((item) => reduceValue(item, depth + 1, maskSensitive, mode))

    if (value.length > MAX_ARRAY_ITEMS) {
      reducedItems.push(`[${value.length - MAX_ARRAY_ITEMS} more items]`)
    }

    return reducedItems
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
    const reducedEntries = entries.slice(0, MAX_OBJECT_KEYS).map(([key, entryValue]) => {
      if (maskSensitive && mode === "normal") {
        if (isStructuredValue(entryValue) && isSensitiveContainerKey(key)) {
          return [key, reduceValue(entryValue, depth + 1, true, "mask-leaves")]
        }
        if (!isStructuredValue(entryValue) && isSensitiveScalarKey(key)) {
          return [key, maskSensitiveScalar(entryValue)]
        }
      }

      return [key, reduceValue(entryValue, depth + 1, maskSensitive, mode)]
    })

    if (entries.length > MAX_OBJECT_KEYS) {
      reducedEntries.push(["__truncated_keys", entries.length - MAX_OBJECT_KEYS])
    }

    return Object.fromEntries(reducedEntries)
  }

  return mode === "mask-leaves" ? MASKED_VALUE : String(value)
}
