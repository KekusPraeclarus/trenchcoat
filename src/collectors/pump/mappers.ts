import { getChain } from "../../lib/chains.js"
import { validateChainAddress } from "../../lib/address.js"
import { inferChainFromTokenAddress } from "../../lib/native-mints.js"
import { asIsoTimestamp } from "./freshness.js"
import type {
  PumpCall,
  PumpFeedItem,
  PumpFeedTab,
  PumpLeaderboardEntry,
} from "./types.js"

const HANDLE_RE = /^[A-Za-z0-9._-]{1,64}$/u
const ITEM_ID_RE = /^[A-Za-z0-9._-]{1,128}$/u
const ADDRESS_KEYS = new Set([
  "address",
  "wallet",
  "walletAddress",
  "solanaAddress",
  "evmAddress",
  "publicKey",
])

function asRecord(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined
  return raw as Record<string, unknown>
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function normalizeHandle(raw: unknown): string | undefined {
  const value = asString(raw)?.replace(/^@/u, "")
  if (!value || !HANDLE_RE.test(value)) return undefined
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/u.test(value) && !value.includes(".")) {
    return undefined
  }
  return value
}

function normalizeItemId(raw: unknown): string | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const id = String(Math.trunc(raw))
    return ITEM_ID_RE.test(id) ? id : undefined
  }
  const value = asString(raw)
  if (!value || !ITEM_ID_RE.test(value)) return undefined
  return value
}

function pickMint(raw: Record<string, unknown>): string | undefined {
  return asString(raw["mint"])
    ?? asString(raw["coinMint"])
    ?? asString(raw["tokenAddress"])
    ?? asString(raw["token_mint"])
    ?? asString(raw["ca"])
    ?? asString(asRecord(raw["token"])?.["mint"])
    ?? asString(asRecord(raw["coin"])?.["mint"])
}

export function describeHandleField(value: unknown): string {
  if (typeof value !== "string") return value == null ? "empty" : typeof value
  const trimmed = value.trim().replace(/^@/u, "")
  if (trimmed.length === 0) return "empty"
  if (normalizeHandle(trimmed)) return "handle"
  if (/\s/u.test(trimmed)) return "spaces"
  if (trimmed.length > 64) return "long"
  return "other"
}

function lookupHandle(
  raw: Record<string, unknown>,
  usernames: ReadonlyMap<string, string>,
): string | undefined {
  const direct = normalizeHandle(
    raw["author"]
    ?? raw["username"]
    ?? raw["handle"]
    ?? raw["xUsername"]
    ?? raw["creatorUsername"]
    ?? raw["user"]
    ?? asRecord(raw["user"])?.["username"]
    ?? asRecord(raw["creator"])?.["username"],
  )
  if (direct) return direct
  for (const key of ["creator", "userId", "address", "walletAddress"]) {
    const id = asString(raw[key]) ?? asString(asRecord(raw[key])?.["address"])
    if (id) {
      const handle = usernames.get(id)
      if (handle) return handle
    }
  }
  return undefined
}

function resolveChain(raw: Record<string, unknown>, mint: string): string | undefined {
  const slug = asString(raw["chain"])?.toLowerCase()
  if (slug && getChain(slug)) return slug
  return inferChainFromTokenAddress(mint)
}

function stripAddressFields(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (ADDRESS_KEYS.has(key)) continue
    out[key] = value
  }
  return out
}

export function indexPumpUsernames(rows: readonly unknown[]): ReadonlyMap<string, string> {
  const out = new Map<string, string>()
  for (const row of rows) {
    const raw = asRecord(row)
    if (!raw) continue
    const handle = normalizeHandle(raw["username"] ?? raw["handle"] ?? raw["xUsername"])
    const address = asString(raw["address"])
    if (!handle || !address) continue
    out.set(address, handle)
  }
  return out
}

/**
 * Map a feed card. Drop the item when mint/CA is missing or invalid.
 * Do not invent addresses. Do not use a wallet as author.
 */
export function mapFeedItem(
  rawUnknown: unknown,
  tab: PumpFeedTab,
  observedAt: string,
  usernames: ReadonlyMap<string, string> = new Map(),
): PumpFeedItem | undefined {
  const raw = asRecord(rawUnknown)
  if (!raw) return undefined
  const mint = pickMint(raw)
  const itemId = normalizeItemId(
    raw["calloutId"] ?? raw["id"] ?? raw["itemId"] ?? raw["coinId"] ?? mint,
  )
  const author = lookupHandle(raw, usernames)
  if (!itemId || !author) return undefined
  if (!mint) return undefined
  const chain = resolveChain(raw, mint)
  if (!chain) return undefined
  const chainEntry = getChain(chain)
  if (!chainEntry || !validateChainAddress(chainEntry.addressFormat, mint)) return undefined
  return {
    itemId,
    author,
    tab,
    mint,
    chain,
    observedAt,
  }
}

/**
 * Leaderboard rows keep handles only. Address fields are dropped.
 */
export function mapLeaderboardEntry(
  rawUnknown: unknown,
  observedAt: string,
  rankFallback: number,
  usernames: ReadonlyMap<string, string> = new Map(),
): PumpLeaderboardEntry | undefined {
  const raw = asRecord(rawUnknown)
  if (!raw) return undefined
  const address = asString(raw["address"])
    ?? asString(raw["userId"])
    ?? asString(raw["walletAddress"])
  const handle = lookupHandle(raw, usernames)
    ?? (address ? usernames.get(address) : undefined)
  if (!handle) return undefined
  const rankRaw = stripAddressFields(raw)["rank"]
  const rank = typeof rankRaw === "number" && Number.isFinite(rankRaw)
    ? Math.max(1, Math.trunc(rankRaw))
    : rankFallback
  return { handle, rank, observedAt }
}

export function mapCallerCall(
  rawUnknown: unknown,
  callerId: string,
  observedAt: string,
): PumpCall | undefined {
  const raw = asRecord(rawUnknown)
  if (!raw) return undefined
  const mint = pickMint(raw)
  if (!mint) return undefined
  const chain = resolveChain(raw, mint)
  if (!chain) return undefined
  const chainEntry = getChain(chain)
  if (!chainEntry || !validateChainAddress(chainEntry.addressFormat, mint)) return undefined
  const calledAt = asIsoTimestamp(raw["calledAt"] ?? raw["createdAt"] ?? raw["timestamp"]) ?? observedAt
  const itemId = normalizeItemId(raw["calloutId"] ?? raw["id"] ?? raw["itemId"] ?? mint)
  return {
    callerId,
    chain,
    tokenAddress: mint,
    calledAt,
    ...(itemId ? { itemId } : {}),
  }
}

export function extractArrayPayload(body: unknown): unknown[] {
  if (Array.isArray(body)) return body
  const raw = asRecord(body)
  if (!raw) return []
  for (const key of ["items", "coins", "mints", "feed", "data", "users", "leaderboard", "calls", "entries"]) {
    const value = raw[key]
    if (Array.isArray(value)) return value
    const nested = asRecord(value)
    if (nested && Array.isArray(nested["items"])) return nested["items"] as unknown[]
  }
  for (const key of ["callout", "coin"]) {
    const nested = asRecord(raw[key])
    if (nested) return [nested]
  }
  return []
}
