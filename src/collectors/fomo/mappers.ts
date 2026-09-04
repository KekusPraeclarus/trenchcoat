import { getChain } from "../../lib/chains.js"
import { isValidEvmAddress, validateChainAddress } from "../../lib/address.js"
import { inferChainFromTokenAddress, isQuoteOrNativeMint } from "../../lib/native-mints.js"
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

const SUPPORTED = new Set(["solana", "base", "ethereum", "bsc"])

/** Defined.fi / Fomo networkId → trenchcoat chain slug */
const NETWORK_ID_TO_CHAIN: Readonly<Record<number, string>> = {
  1: "ethereum",
  8453: "base",
  56: "bsc",
  1399811149: "solana",
}

function mapChain(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const slug = raw.trim().toLowerCase()
  if (slug === "bnb" || slug === "bsc") return getChain("bsc") ? "bsc" : undefined
  if (!SUPPORTED.has(slug)) return undefined
  return getChain(slug) ? slug : undefined
}

function mapNetworkId(networkId: number | undefined): string | undefined {
  if (networkId === undefined) return undefined
  const mapped = NETWORK_ID_TO_CHAIN[networkId]
  if (!mapped) return undefined
  return getChain(mapped) ? mapped : undefined
}

function actionFromRaw(value: Readonly<{
  action?: "buy" | "sell" | undefined
  side?: "buy" | "sell" | undefined
  type?: string | undefined
}>): "buy" | "sell" | undefined {
  if (value.action === "buy" || value.action === "sell") return value.action
  if (value.side === "buy" || value.side === "sell") return value.side
  if (typeof value.type === "string") {
    if (/sell/iu.test(value.type)) return "sell"
    if (/buy/iu.test(value.type)) return "buy"
  }
  return undefined
}

function resolveActivityChain(args: Readonly<{
  chainRaw?: string | undefined
  networkId?: number | undefined
  tokenAddress?: string | undefined
}>): string | undefined {
  return mapChain(args.chainRaw)
    ?? mapNetworkId(args.networkId)
    ?? (args.tokenAddress ? inferChainFromTokenAddress(args.tokenAddress) : undefined)
}

function normalizeXHandle(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const trimmed = raw.trim()
  const fromUrl = trimmed.match(/(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?:[/?#]|$)/iu)
  const handle = (fromUrl?.[1] ?? trimmed.replace(/^@/u, "")).toLowerCase()
  if (!/^[a-z0-9_]{1,15}$/u.test(handle)) return undefined
  return handle
}

function socialTextCandidates(candidate: unknown): string[] {
  if (typeof candidate === "string") return [candidate]
  if (!candidate || typeof candidate !== "object") return []
  const record = candidate as Record<string, unknown>
  const texts: string[] = []
  for (const key of ["url", "link", "x_url", "twitter_url", "username", "handle", "userHandle"]) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) texts.push(value)
  }
  return texts
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
    for (const text of socialTextCandidates(candidate)) {
      const handle = normalizeXHandle(text)
      if (!handle) continue
      return {
        xHandle: handle,
        xProfileUrl: `https://x.com/${handle}`,
      }
    }
  }
  return {}
}

function present<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined
}

function resolveHandle(value: Readonly<{
  handle?: string | undefined
  userHandle?: string | undefined
  displayName?: string | undefined
}>): string | undefined {
  const raw = value.userHandle ?? value.handle ?? value.displayName
  if (!raw) return undefined
  const handle = raw.trim().toLowerCase().replace(/^@/u, "")
  if (!handle || handle.length > 64) return undefined
  return handle
}

export function mapTrader(raw: unknown, observedAt?: string): FomoTrader | undefined {
  const parsed = FomoRawTraderSchema.safeParse(raw)
  if (!parsed.success) return undefined
  const value = parsed.data
  const handle = resolveHandle({
    handle: present(value.handle),
    userHandle: present(value.userHandle),
    displayName: present(value.displayName),
  })
  if (!handle) return undefined
  // Fomo profile address/evmAddress are not trading wallets — never bind them
  const x = extractXLink(value as Record<string, unknown>)
  const winRate = present(value.win_rate ?? value.winRate)
  const pnl = present(value.pnl ?? value.pnl7d ?? value.pnl24h ?? value.pnl30d)
  const trades = present(value.trades ?? value.numTrades ?? value.swapCount)
  return {
    handle,
    ...(pnl !== undefined ? { pnl } : {}),
    ...(winRate !== undefined ? { winRate } : {}),
    ...(trades !== undefined ? { trades } : {}),
    wallets: [],
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
  const rank = parsed.success && parsed.data.rank != null
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
  const body = value.body && typeof value.body === "object" ? value.body as Record<string, unknown> : undefined
  const tokenAddress = (
    value.token_mint
    ?? value.tokenAddress
    ?? value.mint
    ?? (typeof body?.["tokenAddress"] === "string" ? body["tokenAddress"] : undefined)
  )?.trim()
  const chain = resolveActivityChain({
    chainRaw: value.chain,
    networkId: value.networkId,
    ...(tokenAddress ? { tokenAddress } : {}),
  })
  const eventAt = asIsoTimestamp(
    value.timestamp ?? value.observed_at ?? value.created_at ?? value.createdAt,
  )
  const action = actionFromRaw(value)
  const usdAmount = value.usd_amount ?? value.usdAmount
    ?? (typeof body?.["totalVolume"] === "number" ? body["totalVolume"] : undefined)
  const handle = resolveHandle({
    handle: value.handle,
    userHandle: value.userHandle,
  })
  const symbol = (value.token_symbol ?? value.symbol
    ?? (typeof body?.["ticker"] === "string" ? body["ticker"] : undefined)
  )?.slice(0, 32)
  if (tokenAddress && chain) {
    const entry = getChain(chain)
    if (!entry || !validateChainAddress(entry.addressFormat, tokenAddress)) {
      return {
        ...(handle ? { handle } : {}),
        ...(action ? { action } : {}),
        ...(usdAmount !== undefined ? { usdAmount } : {}),
        ...(value.tx_hash ? { txHash: value.tx_hash } : {}),
        ...(eventAt ? { eventAt } : {}),
      }
    }
  }
  return {
    ...(handle ? { handle } : {}),
    ...(action ? { action } : {}),
    ...(chain ? { chain } : {}),
    ...(tokenAddress ? { tokenAddress } : {}),
    ...(symbol ? { symbol } : {}),
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

/** Expand multi-user feed cards into per-handle buy/sell events for signal derivation */
export function expandFeedItems(raw: unknown, observedAt: string): FomoTradeEvent[] {
  const direct = mapTradeEvent(raw, observedAt)
  if (direct?.handle && direct.tokenAddress && direct.chain) return [direct]

  const parsed = FomoRawActivitySchema.safeParse(raw)
  if (!parsed.success) return direct ? [direct] : []
  const value = parsed.data
  const body = value.body && typeof value.body === "object" ? value.body as Record<string, unknown> : undefined
  const topTraders = Array.isArray(body?.["topTraders"]) ? body["topTraders"] : []
  if (topTraders.length === 0) return direct ? [direct] : []

  const tokenAddress = (
    value.tokenAddress
    ?? value.token_mint
    ?? value.mint
    ?? (typeof body?.["tokenAddress"] === "string" ? body["tokenAddress"] : undefined)
  )?.trim()
  const chain = resolveActivityChain({
    chainRaw: value.chain,
    networkId: value.networkId,
    ...(tokenAddress ? { tokenAddress } : {}),
  })
  const eventAt = asIsoTimestamp(value.createdAt ?? value.created_at ?? value.timestamp)
  const action = actionFromRaw(value) ?? "buy"
  if (!chain || !tokenAddress || !eventAt) return direct ? [direct] : []
  const entry = getChain(chain)
  if (!entry || !validateChainAddress(entry.addressFormat, tokenAddress)) return []

  const symbol = typeof body?.["ticker"] === "string" ? body["ticker"].slice(0, 32) : undefined
  const volume = typeof body?.["totalVolume"] === "number" ? body["totalVolume"] : undefined
  const handles: string[] = []
  for (const trader of topTraders) {
    if (!trader || typeof trader !== "object") continue
    const handle = resolveHandle(trader as { userHandle?: string, handle?: string, displayName?: string })
    if (!handle) continue
    handles.push(handle)
  }
  if (handles.length === 0) return direct ? [direct] : []
  return handles.map((handle) => ({
    ...(value.id !== undefined ? { sourceId: `${String(value.id)}:${handle}` } : {}),
    handle,
    action,
    chain,
    tokenAddress,
    ...(symbol ? { symbol } : {}),
    ...(volume !== undefined ? { usdAmount: volume / handles.length } : {}),
    eventAt,
    observedAt,
  }))
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
  const nested = value.token
  const chain = mapChain(value.chain)
    ?? mapNetworkId(value.networkId)
    ?? mapNetworkId(nested?.networkId)
  const tokenAddress = (
    value.mint
    ?? value.token_mint
    ?? value.tokenAddress
    ?? nested?.address
  )?.trim()
  if (!tokenAddress || !chain) return undefined
  const entry = getChain(chain)
  if (!entry || !validateChainAddress(entry.addressFormat, tokenAddress)) return undefined
  const uniqueBuyers = value.unique_buyers ?? value.uniqueBuyers
  const symbol = value.symbol ?? nested?.symbol
  return {
    chain,
    tokenAddress,
    ...(symbol ? { symbol: symbol.slice(0, 32) } : {}),
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

export function alertFromTradeEvent(trade: FomoTradeEvent): FomoAlertEvent {
  return {
    ...(trade.sourceId ? { sourceId: trade.sourceId } : {}),
    kind: "followed-trade",
    ...(trade.handle ? { handle: trade.handle } : {}),
    ...(trade.action ? { action: trade.action } : {}),
    ...(trade.chain ? { chain: trade.chain } : {}),
    ...(trade.tokenAddress ? { tokenAddress: trade.tokenAddress } : {}),
    ...(trade.symbol ? { symbol: trade.symbol } : {}),
    ...(trade.usdAmount !== undefined ? { usdAmount: trade.usdAmount } : {}),
    eventAt: trade.eventAt,
    observedAt: trade.observedAt,
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

/** Live profile envelope is `{ responseObject: user }` for `/v2/users/userHandle/{handle}`. */
export function extractProfileUser(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return undefined
  const record = payload as Record<string, unknown>
  const nested = record["responseObject"]
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const user = Reflect.get(nested, "user")
    if (user && typeof user === "object" && !Array.isArray(user)) return user
    return nested
  }
  return undefined
}

export function extractArrayPayload(payload: unknown, keys: readonly string[]): unknown[] {
  if (Array.isArray(payload)) return payload
  if (payload === null || typeof payload !== "object") return []
  const record = payload as Record<string, unknown>
  for (const key of keys) {
    const value = Reflect.get(record, key)
    if (Array.isArray(value)) return value
  }
  const nested = record["responseObject"]
  if (Array.isArray(nested)) return nested
  if (nested && typeof nested === "object") {
    for (const key of keys) {
      const value = Reflect.get(nested, key)
      if (Array.isArray(value)) return value
    }
  }
  return []
}

function nestedAddress(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim()
  if (!value || typeof value !== "object") return undefined
  const address = Reflect.get(value as object, "address")
  if (typeof address === "string" && address.trim()) return address.trim()
  return undefined
}

function stringField(value: Readonly<Record<string, unknown>>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const found = nestedAddress(value[key])
    if (found) return found
  }
  return undefined
}

/**
 * Quote→meme profile swaps only. Sells, meme↔meme, and quote/native mints
 * never become shiller calls. Profile wallets stay unused.
 */
export function mapProfileSwapBuy(
  raw: unknown,
  handle: string,
  observedAt: string,
): FomoTradeEvent | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const value = raw as Record<string, unknown>
  const inAddr = stringField(value, ["inTokenAddress", "inMint", "fromTokenAddress", "tokenIn"])
  const outAddr = stringField(value, ["outTokenAddress", "outMint", "toTokenAddress", "tokenOut"])
  if (!inAddr || !outAddr) return undefined
  const inSymbol = stringField(value, ["inTokenSymbol", "inSymbol"])
  const outSymbol = stringField(value, ["outTokenSymbol", "outSymbol", "symbol"])
  if (!isQuoteOrNativeMint(inAddr, inSymbol) || isQuoteOrNativeMint(outAddr, outSymbol)) {
    return undefined
  }
  const eventAt = asIsoTimestamp(
    value["timestamp"]
    ?? value["createdAt"]
    ?? value["created_at"]
    ?? value["executedAt"]
    ?? value["swappedAt"]
    ?? value["blockTime"]
    ?? value["time"],
  )
  if (!eventAt) return undefined
  const networkId = typeof value["networkId"] === "number" ? value["networkId"] : undefined
  const chain = resolveActivityChain({
    chainRaw: typeof value["chain"] === "string" ? value["chain"] : undefined,
    networkId,
    tokenAddress: outAddr,
  })
  if (chain) {
    const entry = getChain(chain)
    if (!entry || !validateChainAddress(entry.addressFormat, outAddr)) return undefined
  } else if (!isValidEvmAddress(outAddr)) {
    return undefined
  }
  const id = value["id"]
  return {
    ...(id !== undefined ? { sourceId: String(id) } : {}),
    handle,
    action: "buy",
    ...(chain ? { chain } : {}),
    tokenAddress: outAddr,
    ...(outSymbol ? { symbol: outSymbol.slice(0, 32) } : {}),
    eventAt,
    observedAt,
  }
}

export function mapProfileSwapBuys(
  payload: unknown,
  handle: string,
  observedAt: string,
): FomoTradeEvent[] {
  const rows = extractArrayPayload(payload, ["swaps", "data", "items", "responseObject"])
  const list = rows.length > 0 ? rows : (Array.isArray(payload) ? payload : [])
  const seen = new Set<string>()
  const out: FomoTradeEvent[] = []
  for (const row of list) {
    const mapped = mapProfileSwapBuy(row, handle, observedAt)
    if (!mapped?.tokenAddress) continue
    const key = `${mapped.tokenAddress.toLowerCase()}|${mapped.eventAt}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(mapped)
    if (out.length >= 200) break
  }
  return out
}

export { normalizeXHandle, mapNetworkId }
