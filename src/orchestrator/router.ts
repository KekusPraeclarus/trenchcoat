import { sha256Json } from "../lib/canonical-json.js"
import type { FetchLike } from "../collectors/market/geckoterminal.js"

const MAX_RESPONSE_BYTES = 64 * 1024
const SAFE_SUBJECT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const SAFE_RULE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const SAFE_REF = /^state\/[A-Za-z0-9._/-]+$/

export type BroadcastSeverity = "notable" | "urgent" | "watch"
export type BroadcastClaimType =
  | "narrative-emergence"
  | "narrative-fade"
  | "rotation"
  | "sentiment-collapse"
  | "token-downside"
  | "token-upside"
export type BroadcastDirection = "down" | "rotation" | "up"

export type AuditClaim = Readonly<{
  type: BroadcastClaimType
  subject: string
  direction: BroadcastDirection
  horizonHours: number
  verificationRule: string
}>

export type BroadcastItem = Readonly<{
  severity: BroadcastSeverity
  text: string
  refs: readonly string[]
  auditClaim: AuditClaim
}>

export type RouterPayload = Readonly<{
  schema: 1
  eventId: `sha256:${string}`
  occurredAt: string
  severity: BroadcastSeverity
  text: string
  refs: readonly string[]
  auditClaim: AuditClaim
}>

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
  }
}

function validateBroadcast(item: BroadcastItem): void {
  const textLength = [...item.text].length
  if (textLength < 1 || textLength > 280 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(item.text)) {
    throw new TypeError("Broadcast text is empty, too long, or contains control characters")
  }

  if (item.refs.length > 10 || new Set(item.refs).size !== item.refs.length) {
    throw new TypeError("Broadcast refs are duplicated or exceed the limit")
  }

  for (const ref of item.refs) {
    if (
      !SAFE_REF.test(ref)
      || ref.includes("..")
      || ref.startsWith("/")
      || ref.includes("//")
    ) {
      throw new TypeError("Broadcast ref is not a safe state-relative path")
    }
  }

  if (!SAFE_SUBJECT.test(item.auditClaim.subject)) {
    throw new TypeError("Broadcast audit subject is invalid")
  }

  if (!SAFE_RULE.test(item.auditClaim.verificationRule)) {
    throw new TypeError("Broadcast verification rule is invalid")
  }

  if (
    !Number.isSafeInteger(item.auditClaim.horizonHours)
    || item.auditClaim.horizonHours < 1
    || item.auditClaim.horizonHours > 168
  ) {
    throw new TypeError("Broadcast audit horizon must be from 1 to 168 hours")
  }

  if (item.auditClaim.direction !== expectedDirection(item.auditClaim.type)) {
    throw new TypeError("Broadcast claim direction is incompatible with its type")
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) {
    return undefined
  }

  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds)
  }

  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) {
    return undefined
  }

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

  if (body.length === 0) {
    return null
  }

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
    || !SAFE_SUBJECT.test(deliveryId)
  ) {
    throw new RouterDeliveryError("Router returned an invalid receipt", false)
  }

  return { status, deliveryId }
}

export function validateRouterUrl(url: string, allowInsecureLoopback = false): URL {
  const parsed = new URL(url)
  const loopback = parsed.hostname === "127.0.0.1"
    || parsed.hostname === "::1"
    || parsed.hostname === "localhost"

  if (parsed.protocol !== "https:" && !(allowInsecureLoopback && loopback)) {
    throw new TypeError("Router URL must use HTTPS")
  }

  if (parsed.username || parsed.password || parsed.hash) {
    throw new TypeError("Router URL cannot contain credentials or a fragment")
  }

  return parsed
}

export function buildRouterPayload(
  runId: string,
  occurredAt: string,
  item: BroadcastItem,
): RouterPayload {
  validateBroadcast(item)

  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(runId)) {
    throw new TypeError("Run id is invalid")
  }

  const occurredTimestamp = Date.parse(occurredAt)
  if (!Number.isFinite(occurredTimestamp) || new Date(occurredTimestamp).toISOString() !== occurredAt) {
    throw new TypeError("occurredAt must be a canonical ISO timestamp")
  }

  const eventId = sha256Json({
    runId,
    severity: item.severity,
    text: item.text,
    refs: [...item.refs],
    auditClaim: {
      type: item.auditClaim.type,
      subject: item.auditClaim.subject,
      direction: item.auditClaim.direction,
      horizonHours: item.auditClaim.horizonHours,
      verificationRule: item.auditClaim.verificationRule,
    },
  })

  return Object.freeze({
    schema: 1,
    eventId,
    occurredAt,
    severity: item.severity,
    text: item.text,
    refs: Object.freeze([...item.refs]),
    auditClaim: Object.freeze({ ...item.auditClaim }),
  })
}

export async function deliverBroadcast(
  fetcher: FetchLike,
  routerUrl: string,
  token: string,
  payload: RouterPayload,
  timeoutMs = 10_000,
): Promise<RouterDeliveryResult> {
  const url = validateRouterUrl(routerUrl)

  if (token.length < 1 || token.length > 4_096 || /[\r\n]/u.test(token)) {
    throw new TypeError("Router token is invalid")
  }

  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError("timeoutMs must be an integer from 1 to 60000")
  }

  const response = await fetcher(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": payload.eventId,
    },
    body: JSON.stringify({
      schema: payload.schema,
      event_id: payload.eventId,
      occurred_at: payload.occurredAt,
      severity: payload.severity,
      text: payload.text,
      refs: payload.refs,
      audit_claim: {
        type: payload.auditClaim.type,
        subject: payload.auditClaim.subject,
        direction: payload.auditClaim.direction,
        horizon_hours: payload.auditClaim.horizonHours,
        verification_rule: payload.auditClaim.verificationRule,
      },
    }),
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  })

  const body = await parseResponseBody(response)

  if (response.ok) {
    const receipt = readReceipt(body, "accepted")
    return { ...receipt, eventId: payload.eventId }
  }

  if (response.status === 409) {
    const receipt = readReceipt(body, "duplicate")
    return { ...receipt, eventId: payload.eventId }
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
