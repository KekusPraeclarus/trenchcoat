import { randomBytes } from "node:crypto"
import type { FetchLike } from "../collectors/market/geckoterminal.js"
import {
  BroadcastItemSchema,
  type BroadcastItem,
  type RouterEvent,
} from "../contracts/schemas.js"
import { sha256Json } from "../lib/canonical-json.js"
import { signRouterRequest } from "../lib/router-contract.js"
import { isKnownVerificationRule } from "./broadcast.js"

const MAX_RESPONSE_BYTES = 64 * 1024
const SAFE_DELIVERY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

export type BroadcastClaimType = BroadcastItem["auditClaim"]["type"]
export type BroadcastDirection = BroadcastItem["auditClaim"]["direction"]

export type RouterDeliveryResult = Readonly<{
  status: "accepted" | "duplicate"
  deliveryId: string
  eventId: `sha256:${string}`
}>

export class RouterDeliveryError extends Error {
  readonly retryable: boolean
  readonly retryAfterSeconds: number | undefined

  constructor(
    message: string,
    retryable: boolean,
    retryAfterSeconds?: number,
  ) {
    super(message)
    this.name = "RouterDeliveryError"
    this.retryable = retryable
    this.retryAfterSeconds = retryAfterSeconds
  }
}

function expectedDirection(type: BroadcastClaimType): BroadcastDirection {
  switch (type) {
    case "narrative-emergence":
    case "token-upside":
      return "up"
    case "narrative-fade":
    case "sentiment-collapse":
    case "token-downside":
      return "down"
    case "rotation":
      return "rotation"
    case "wallet-lifecycle":
      return "lifecycle"
  }
}

export function validateBroadcastItem(item: unknown): BroadcastItem {
  const parsed = BroadcastItemSchema.parse(item)
  const textLength = [...parsed.text].length
  if (textLength < 1 || textLength > 280 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(parsed.text)) {
    throw new TypeError("Broadcast text is empty, too long, or contains control characters")
  }
  if (new Set(parsed.refs).size !== parsed.refs.length) {
    throw new TypeError("Broadcast refs are duplicated or exceed the limit")
  }
  for (const ref of parsed.refs) {
    if (ref.includes("..") || ref.startsWith("/") || ref.includes("//")) {
      throw new TypeError("Broadcast ref is not a safe state-relative path")
    }
  }
  if (!isKnownVerificationRule(parsed.auditClaim.verificationRule)) {
    throw new TypeError("Broadcast verification rule is unknown")
  }
  if (parsed.auditClaim.direction !== expectedDirection(parsed.auditClaim.type)) {
    throw new TypeError("Broadcast claim direction is incompatible with its type")
  }
  return parsed
}

export function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1"
    || hostname === "::1"
    || hostname === "localhost"
}

/**
 * Resolve intake URL. Bare host roots (`http://127.0.0.1:8787/`) map to `/v1/events`
 * so signing path and POST target stay aligned.
 */
export function resolveRouterIntakeUrl(url: string, allowInsecureLoopback = false): URL {
  const parsed = validateRouterUrl(url, allowInsecureLoopback)
  const path = parsed.pathname.replace(/\/$/u, "") || "/v1/events"
  parsed.pathname = path
  return parsed
}

export function validateRouterUrl(url: string, _allowInsecureLoopback = false): URL {
  const parsed = new URL(url)
  const loopback = isLoopbackHostname(parsed.hostname)

  // Local deploy uses plain HTTP on loopback (.env.example). Off-loopback still requires HTTPS.
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new TypeError("Router URL must use HTTPS (HTTP only on loopback)")
  }

  if (parsed.username || parsed.password || parsed.hash) {
    throw new TypeError("Router URL cannot contain credentials or a fragment")
  }

  return parsed
}

/** Build a durable finding.broadcast RouterEvent from a validated BroadcastItem */
export function buildBroadcastRouterEvent(
  runId: string,
  occurredAt: string,
  item: BroadcastItem,
): RouterEvent {
  const validated = validateBroadcastItem(item)

  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(runId)) {
    throw new TypeError("Run id is invalid")
  }

  const occurredTimestamp = Date.parse(occurredAt)
  if (!Number.isFinite(occurredTimestamp) || new Date(occurredTimestamp).toISOString() !== occurredAt) {
    throw new TypeError("occurredAt must be a canonical ISO timestamp")
  }

  const eventId = sha256Json({
    runId,
    type: "finding.broadcast",
    severity: validated.severity,
    text: validated.text,
    refs: [...validated.refs],
    auditClaim: {
      type: validated.auditClaim.type,
      subject: validated.auditClaim.subject,
      direction: validated.auditClaim.direction,
      horizonHours: validated.auditClaim.horizonHours,
      verificationRule: validated.auditClaim.verificationRule,
    },
  })

  return {
    schema: 1,
    eventId,
    occurredAt,
    runId,
    type: "finding.broadcast",
    severity: validated.severity,
    text: validated.text,
    refs: [...validated.refs],
    auditClaim: { ...validated.auditClaim },
  }
}

/** @deprecated Prefer buildBroadcastRouterEvent — kept for call-site migration */
export function buildRouterPayload(
  runId: string,
  occurredAt: string,
  item: BroadcastItem,
): RouterEvent {
  return buildBroadcastRouterEvent(runId, occurredAt, item)
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds)
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return undefined
  return Math.max(0, Math.ceil((timestamp - Date.now()) / 1_000))
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0)
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new RouterDeliveryError("Router response exceeds the size limit", false)
  }
  const body = await response.text()
  if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
    throw new RouterDeliveryError("Router response exceeds the size limit", false)
  }
  if (body.length === 0) return null
  const contentType = response.headers.get("content-type")
  if (!contentType?.toLowerCase().includes("application/json")) {
    throw new RouterDeliveryError("Router returned a non-JSON response", false)
  }
  try {
    return JSON.parse(body)
  } catch {
    throw new RouterDeliveryError("Router returned malformed JSON", false)
  }
}

function readReceipt(
  body: unknown,
  expectedStatus: "accepted" | "duplicate",
): { status: "accepted" | "duplicate"; deliveryId: string } {
  if (body === null || typeof body !== "object") {
    throw new RouterDeliveryError("Router response omitted its receipt", false)
  }
  const status = Reflect.get(body, "status")
  const deliveryId = Reflect.get(body, "delivery_id")
  if (
    status !== expectedStatus
    || typeof deliveryId !== "string"
    || !SAFE_DELIVERY_ID.test(deliveryId)
  ) {
    throw new RouterDeliveryError("Router returned an invalid receipt", false)
  }
  return { status, deliveryId }
}

/**
 * POST a RouterEvent to the in-repo HMAC intake. Uses loopback HTTP only in tests.
 * Bearer tokens are never used (ADR 001 / INV-B5).
 */
export async function deliverRouterEvent(
  fetcher: FetchLike,
  routerUrl: string,
  hmacKey: string,
  event: RouterEvent,
  timeoutMs = 10_000,
  allowInsecureLoopback = false,
): Promise<RouterDeliveryResult> {
  const url = resolveRouterIntakeUrl(routerUrl, allowInsecureLoopback)
  if (hmacKey.length < 8 || hmacKey.length > 4_096 || /[\r\n]/u.test(hmacKey)) {
    throw new TypeError("Router HMAC key is invalid")
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError("timeoutMs must be an integer from 1 to 60000")
  }

  const path = url.pathname
  const body = JSON.stringify(event)
  const timestamp = new Date().toISOString()
  const nonce = `n-${Date.now()}-${randomBytes(8).toString("hex")}`
  const signature = signRouterRequest(hmacKey, "POST", path, timestamp, nonce, body)

  const response = await fetcher(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-tc-timestamp": timestamp,
      "x-tc-nonce": nonce,
      "x-tc-signature": signature,
    },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  })

  const responseBody = await parseResponseBody(response)

  if (response.status === 202) {
    const receipt = readReceipt(responseBody, "accepted")
    return { ...receipt, eventId: event.eventId as `sha256:${string}` }
  }
  if (response.status === 200) {
    const receipt = readReceipt(responseBody, "duplicate")
    return { ...receipt, eventId: event.eventId as `sha256:${string}` }
  }
  if (response.status === 409) {
    throw new RouterDeliveryError("Router eventId/payload conflict", false)
  }
  if (response.status === 401) {
    throw new RouterDeliveryError("Router HMAC rejected", false)
  }

  const retryable = response.status === 408
    || response.status === 425
    || response.status === 429
    || response.status >= 500

  throw new RouterDeliveryError(
    `Router delivery failed with HTTP ${response.status}`,
    retryable,
    parseRetryAfter(response.headers.get("retry-after")),
  )
}

/** Deliver a BroadcastItem as a finding.broadcast event via HMAC intake */
export async function deliverBroadcast(
  fetcher: FetchLike,
  routerUrl: string,
  hmacKey: string,
  runId: string,
  occurredAt: string,
  item: BroadcastItem,
  timeoutMs = 10_000,
  allowInsecureLoopback = false,
): Promise<RouterDeliveryResult> {
  const event = buildBroadcastRouterEvent(runId, occurredAt, item)
  return deliverRouterEvent(
    fetcher,
    routerUrl,
    hmacKey,
    event,
    timeoutMs,
    allowInsecureLoopback,
  )
}
