import { getChain } from "../../lib/chains.js"
import { validateChainAddress } from "../../lib/address.js"
import { asIsoTimestamp } from "./freshness.js"
import {
  FomoRawActivitySchema,
  FomoRawAlertSchema,
  FomoRawConvergenceSchema,
  FomoRawHotTokenSchema,
  FomoRawThesisSchema,
  FomoRawTraderSchema,
  type FomoActivity,
  type FomoAlertEvent,
  type FomoConvergence,
  type FomoHotToken,
  type FomoLeaderboardEntry,
  type FomoThesis,
  type FomoTradeEvent,
  type FomoTrader,
  type FomoTrendingObservation,
} from "./types.js"

const SUPPORTED = new Set(["solana", "base", "ethereum"])

function mapChain(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const slug = raw.trim().toLowerCase()
  if (slug === "bnb" || slug === "bsc") return "bsc"
  if (!SUPPORTED.has(slug)) return undefined
  return slug
}

function pushWallet(
  wallets: { chain: string, address: string }[],
  chainRaw: string | undefined,
  addressRaw: string | undefined,
): void {
  const chain = mapChain(chainRaw)
  if (!chain || !addressRaw) return
  const entry = getChain(chain)
  if (!entry || entry.walletTracking === "unsupported") return
  if (!validateChainAddress(entry.addressFormat, addressRaw)) return
  wallets.push({ chain, address: addressRaw })
}

function normalizeXHandle(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const trimmed = raw.trim()
  const fromUrl = trimmed.match(/(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?:[/?#]|$)/iu)
  const handle = (fromUrl?.[1] ?? trimmed.replace(/^@/u, "")).toLowerCase()
  if (!/^[a-z0-9_]{1,15}$/u.test(handle)) return undefined
  return handle
}

function extractXLink(value: Readonly<Record<string, unknown>>): Readonly<{
  xHandle?: string
  xProfileUrl?: string
}> {
  const candidates = [
    value["x_url"],
    value["twitter_url"],
    value["twitter"],
    value["x_handle"],
    value["xHandle"],
  ]
  const socials = value["socials"]
  if (socials && typeof socials === "object") {
    candidates.push(
      Reflect.get(socials, "twitter"),
      Reflect.get(socials, "x"),
      Reflect.get(socials, "x_url"),
    )
  }
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue
    const handle = normalizeXHandle(candidate)
    if (!handle) continue
    return {
      xHandle: handle,
      xProfileUrl: `https://x.com/${handle}`,
    }
  }
  return {}
}

export function mapTrader(raw: unknown, observedAt?: string): FomoTrader | undefined {
  const parsed = FomoRawTraderSchema.safeParse(raw)
  if (!parsed.success) return undefined
  const value = parsed.data
  const wallets: { chain: string, address: string }[] = []
  for (const wallet of value.wallets ?? []) {
    pushWallet(wallets, wallet.chain, wallet.address)
  }
  pushWallet(wallets, "solana", value.solana_wallet)
  pushWallet(wallets, "base", value.base_wallet)
  pushWallet(wallets, "ethereum", value.ethereum_wallet)
  const x = extractXLink(value as Record<string, unknown>)
  const winRate = value.win_rate ?? value.winRate
  return {
    handle: value.handle.trim().toLowerCase(),
    ...(value.pnl !== undefined ? { pnl: value.pnl } : {}),
    ...(winRate !== undefined ? { winRate } : {}),
    ...(value.trades !== undefined ? { trades: value.trades } : {}),
    wallets,
    ...x,
    ...(observedAt ? { observedAt } : {}),
  }
}

export function mapLeaderboardEntry(
  raw: unknown,
  observedAt: string,
  timeframe: "24h" | "7d" | "30d" | "all" = "7d",
): FomoLeaderboardEntry | undefined {
  const trader = mapTrader(raw, observedAt)
  if (!trader) return undefined
  const parsed = FomoRawTraderSchema.safeParse(raw)
  const rank = parsed.success && parsed.data.rank !== undefined
    ? parsed.data.rank
    : 0
  return {
    handle: trader.handle,
    timeframe,
    rank,
    ...(trader.pnl !== undefined ? { pnl: trader.pnl } : {}),
    ...(trader.winRate !== undefined ? { winRate: trader.winRate } : {}),
    ...(trader.trades !== undefined ? { trades: trader.trades } : {}),
    wallets: trader.wallets,
    ...(trader.xHandle ? { xHandle: trader.xHandle } : {}),
    ...(trader.xProfileUrl ? { xProfileUrl: trader.xProfileUrl } : {}),
    observedAt,
  }
}

export function mapActivity(raw: unknown): FomoActivity | undefined {
  const parsed = FomoRawActivitySchema.safeParse(raw)
  if (!parsed.success) return undefined
  const value = parsed.data
  const chain = mapChain(value.chain)
  const tokenAddress = (value.token_mint ?? value.tokenAddress ?? value.mint)?.trim()
  const eventAt = asIsoTimestamp(value.timestamp ?? value.observed_at ?? value.created_at)
  const action = value.action ?? value.side
  const usdAmount = value.usd_amount ?? value.usdAmount
  if (tokenAddress && chain) {
    const entry = getChain(chain)
    if (!entry || !validateChainAddress(entry.addressFormat, tokenAddress)) {
      return {
        ...(value.handle ? { handle: value.handle.toLowerCase() } : {}),
        ...(action ? { action } : {}),
        ...(usdAmount !== undefined ? { usdAmount } : {}),
        ...(value.tx_hash ? { txHash: value.tx_hash } : {}),
        ...(eventAt ? { eventAt } : {}),
      }
    }
  }
  return {
    ...(value.handle ? { handle: value.handle.toLowerCase() } : {}),
    ...(action ? { action } : {}),
    ...(chain ? { chain } : {}),
    ...(tokenAddress ? { tokenAddress } : {}),
    ...((value.token_symbol ?? value.symbol)
      ? { symbol: (value.token_symbol ?? value.symbol)!.slice(0, 32) }
      : {}),
    ...(usdAmount !== undefined ? { usdAmount } : {}),
    ...(value.tx_hash ? { txHash: value.tx_hash } : {}),
    ...(eventAt ? { eventAt } : {}),
    ...(value.wallet ? { wallet: value.wallet } : {}),
  }
}

export function mapTradeEvent(raw: unknown, observedAt: string): FomoTradeEvent | undefined {
  const activity = mapActivity(raw)
  if (!activity?.eventAt) return undefined
  const parsed = FomoRawActivitySchema.safeParse(raw)
  const sourceId = parsed.success && parsed.data.id !== undefined
    ? String(parsed.data.id)
    : undefined
  return {
    ...(sourceId ? { sourceId } : {}),
    ...(activity.handle ? { handle: activity.handle } : {}),
    ...(activity.action ? { action: activity.action } : {}),
    ...(activity.chain ? { chain: activity.chain } : {}),
    ...(activity.tokenAddress ? { tokenAddress: activity.tokenAddress } : {}),
    ...(activity.symbol ? { symbol: activity.symbol } : {}),
    ...(activity.usdAmount !== undefined ? { usdAmount: activity.usdAmount } : {}),
    ...(activity.txHash ? { txHash: activity.txHash } : {}),
    eventAt: activity.eventAt,
    observedAt,
    ...(activity.wallet ? { wallet: activity.wallet } : {}),
  }
}

export function mapConvergence(raw: unknown): FomoConvergence | undefined {
  const parsed = FomoRawConvergenceSchema.safeParse(raw)
  if (!parsed.success) return undefined
  const value = parsed.data
  const chain = mapChain(value.chain)
  const tokenAddress = (value.mint ?? value.token_mint ?? value.tokenAddress)?.trim()
  if (tokenAddress && chain) {
    const entry = getChain(chain)
    if (!entry || !validateChainAddress(entry.addressFormat, tokenAddress)) {
      return undefined
    }
  }
  const handles = [
    ...(value.handles ?? []).map((handle) => handle.trim().toLowerCase()),
    ...(value.wallets_involved ?? [])
      .map((item) => item.handle?.trim().toLowerCase())
      .filter((handle): handle is string => Boolean(handle)),
  ]
  const detectedAt = asIsoTimestamp(value.detected_at)
  return {
    ...(chain ? { chain } : {}),
    ...(tokenAddress ? { tokenAddress } : {}),
    ...(value.symbol ? { symbol: value.symbol.slice(0, 32) } : {}),
    handles: [...new Set(handles)],
    ...(value.max_gain_pct !== undefined ? { maxGainPct: value.max_gain_pct } : {}),
    ...(detectedAt ? { detectedAt } : {}),
  }
}

export function mapHotToken(raw: unknown): FomoHotToken | undefined {
  const parsed = FomoRawHotTokenSchema.safeParse(raw)
  if (!parsed.success) return undefined
  const value = parsed.data
  const chain = mapChain(value.chain)
  const tokenAddress = (value.mint ?? value.token_mint ?? value.tokenAddress)?.trim()
  if (!tokenAddress || !chain) return undefined
  const entry = getChain(chain)
  if (!entry || !validateChainAddress(entry.addressFormat, tokenAddress)) return undefined
  const uniqueBuyers = value.unique_buyers ?? value.uniqueBuyers
  return {
    chain,
    tokenAddress,
    ...(value.symbol ? { symbol: value.symbol.slice(0, 32) } : {}),
    ...(uniqueBuyers !== undefined ? { uniqueBuyers } : {}),
  }
}

export function mapTrendingObservation(
  raw: unknown,
  observedAt: string,
  rankFallback = 0,
): FomoTrendingObservation | undefined {
  const hot = mapHotToken(raw)
  if (!hot?.chain || !hot.tokenAddress) return undefined
  const parsed = FomoRawHotTokenSchema.safeParse(raw)
  const rank = parsed.success && parsed.data.rank !== undefined
    ? parsed.data.rank
    : rankFallback
  return {
    rank,
    chain: hot.chain,
    tokenAddress: hot.tokenAddress,
    ...(hot.symbol ? { symbol: hot.symbol } : {}),
    ...(hot.uniqueBuyers !== undefined ? { uniqueBuyers: hot.uniqueBuyers } : {}),
    observedAt,
  }
}

export function mapThesis(raw: unknown, observedAt?: string): FomoThesis | undefined {
  const parsed = FomoRawThesisSchema.safeParse(raw)
  if (!parsed.success) return undefined
  const value = parsed.data
  const text = (value.text ?? value.thesis ?? "").replace(/\s+/gu, " ").trim().slice(0, 2_000)
  if (text.length < 40) return undefined
  const chain = mapChain(value.chain)
  const tokenAddress = (value.mint ?? value.token_mint ?? value.tokenAddress)?.trim()
  if (tokenAddress && chain) {
    const entry = getChain(chain)
    if (!entry || !validateChainAddress(entry.addressFormat, tokenAddress)) {
      return undefined
    }
  }
  const eventAt = asIsoTimestamp(value.timestamp ?? value.created_at)
  if (!eventAt) return undefined
  return {
    ...(value.handle ? { handle: value.handle.toLowerCase() } : {}),
    ...(chain ? { chain } : {}),
    ...(tokenAddress ? { tokenAddress } : {}),
    text,
    eventAt,
    observedAt: observedAt ?? eventAt,
  }
}

export function mapAlertEvent(raw: unknown, observedAt: string): FomoAlertEvent | undefined {
  const parsed = FomoRawAlertSchema.safeParse(raw)
  if (!parsed.success) return undefined
  const value = parsed.data
  const eventAt = asIsoTimestamp(value.timestamp ?? value.created_at)
  if (!eventAt) return undefined
  const chain = mapChain(value.chain)
  const tokenAddress = (value.token_mint ?? value.tokenAddress ?? value.mint)?.trim()
  if (tokenAddress && chain) {
    const entry = getChain(chain)
    if (!entry || !validateChainAddress(entry.addressFormat, tokenAddress)) return undefined
  }
  const action = value.action ?? value.side
  return {
    ...(value.id !== undefined ? { sourceId: String(value.id) } : {}),
    kind: (value.kind ?? value.type ?? "alert").slice(0, 64),
    ...(value.handle ? { handle: value.handle.toLowerCase() } : {}),
    ...(action ? { action } : {}),
    ...(chain ? { chain } : {}),
    ...(tokenAddress ? { tokenAddress } : {}),
    ...(value.symbol ? { symbol: value.symbol.slice(0, 32) } : {}),
    ...(value.usd_amount !== undefined ? { usdAmount: value.usd_amount } : {}),
    eventAt,
    observedAt,
  }
}

export function thesisRubricComplete(thesis: FomoThesis): boolean {
  return Boolean(
    thesis.chain
    && thesis.tokenAddress
    && thesis.handle
    && thesis.eventAt
    && thesis.text.length >= 40
    && thesis.text.length <= 2_000,
  )
}

export function extractArrayPayload(payload: unknown, keys: readonly string[]): unknown[] {
  if (Array.isArray(payload)) return payload
  if (payload === null || typeof payload !== "object") return []
  for (const key of keys) {
    const value = Reflect.get(payload, key)
    if (Array.isArray(value)) return value
  }
  return []
}

export { normalizeXHandle }
