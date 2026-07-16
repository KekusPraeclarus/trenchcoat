import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { sha256Json, type JsonValue } from "./canonical-json.js"
import type { RouterEvent } from "../contracts/schemas.js"
import { RouterEventSchema } from "../contracts/schemas.js"

export const ROUTER_MAX_SKEW_MS = 5 * 60 * 1000

export function eventPayloadHash(event: RouterEvent): `sha256:${string}` {
  return sha256Json(event as unknown as JsonValue)
}

export function canonicalizeRouterEvent(input: unknown): RouterEvent {
  return RouterEventSchema.parse(input)
}

export function buildHmacMessage(
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  bodyHash: `sha256:${string}`,
): string {
  return `${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`
}

export function hashBody(body: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`
}

export function signRouterRequest(
  hmacKey: string,
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  body: string,
): string {
  const digest = hashBody(body)
  const message = buildHmacMessage(method, path, timestamp, nonce, digest)
  return createHmac("sha256", hmacKey).update(message).digest("hex")
}

export function verifyRouterHmac(args: Readonly<{
  hmacKey: string
  method: string
  path: string
  timestamp: string
  nonce: string
  body: string
  signatureHex: string
  nowMs?: number
}>): { ok: true } | { ok: false; reason: string } {
  const now = args.nowMs ?? Date.now()
  const ts = Date.parse(args.timestamp)
  if (!Number.isFinite(ts)) return { ok: false, reason: "bad-timestamp" }
  if (Math.abs(now - ts) > ROUTER_MAX_SKEW_MS) return { ok: false, reason: "skew" }
  if (!/^[A-Za-z0-9._:-]{8,128}$/u.test(args.nonce)) return { ok: false, reason: "bad-nonce" }

  const digest = hashBody(args.body)
  const message = buildHmacMessage(args.method, args.path, args.timestamp, args.nonce, digest)
  const expected = createHmac("sha256", args.hmacKey).update(message).digest("hex")
  const provided = args.signatureHex.toLowerCase()
  if (provided.length !== expected.length) return { ok: false, reason: "bad-signature" }
  const a = Buffer.from(expected, "utf8")
  const b = Buffer.from(provided, "utf8")
  if (!timingSafeEqual(a, b)) return { ok: false, reason: "bad-signature" }
  return { ok: true }
}

export function renderWalletLifecycleLine(transition: Readonly<{
  action: "added" | "dropped"
  chain: string
  address: string
  reasonLine: string
}>): string {
  const short = transition.address.length > 12
    ? `${transition.address.slice(0, 6)}…${transition.address.slice(-4)}`
    : transition.address
  const verb = transition.action === "added" ? "added" : "dropped"
  const line = `wallet ${verb}: ${transition.chain}:${short} — ${transition.reasonLine}`
  return [...line].slice(0, 280).join("")
}
