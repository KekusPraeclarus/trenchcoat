import { gatedFetch, gatedFetchWithRetry, readJsonBody } from "../../lib/http.js"
import type { FetchLike, GeckoPool } from "./geckoterminal.js"
import { fetchGeckoNewPools } from "./geckoterminal.js"

const COINGECKO_HOST_GATE = {
  host: "api.coingecko.com",
  capacity: 25,
  refillPerSecond: 25 / 60,
  monthlyBudget: 10_000,
  timeoutMs: 15_000,
} as const

const FALLBACK_NETWORKS = ["eth", "base", "solana"] as const
const MAX_FALLBACK_ITEMS = 40

const DEXSCREENER_ROOT = "https://api.dexscreener.com"
const COINGECKO_ROOT = "https://api.coingecko.com/api/v3"
const ALTERNATIVE_ROOT = "https://api.alternative.me"
const SAFE_CHAIN = /^[a-z0-9-]{1,64}$/u
const SAFE_PAIR = /^[A-Za-z0-9]{1,128}$/u
const MAX_LIST = 100

export type MarketPair = Readonly<{
  chainId: string
  pairAddress: string
  baseToken: Readonly<{ address: string; symbol: string; name: string }>
  quoteToken: Readonly<{ address: string; symbol: string; name: string }>
  priceUsd?: number
  liquidityUsd?: number
  volume24hUsd?: number
  fdv?: number
  buys24h: number
  sells24h: number
  url: string
}>

export type DexBoost = Readonly<{
  chainId: string
  tokenAddress: string
  amount: number
  totalAmount: number
  description?: string
  url?: string
}>

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new TypeError(`DexScreener pair has invalid ${field}`)
  }
  return value
}

/** CoinGecko category ids are numeric; prefer slug when present */
function coingeckoCategoryId(entry: object): string {
  const slug = Reflect.get(entry, "slug")
  if (typeof slug === "string" && slug.length > 0 && slug.length <= 512) return slug
  const id = Reflect.get(entry, "id")
  if (typeof id === "string" && id.length > 0 && id.length <= 512) return id
  if (typeof id === "number" && Number.isFinite(id)) return String(id)
  throw new TypeError("CoinGecko category missing id")
}

function parseDexScreenerPair(raw: unknown): MarketPair | undefined {
  if (raw === null || typeof raw !== "object") return undefined
  const base = Reflect.get(raw, "baseToken")
  const quote = Reflect.get(raw, "quoteToken")
  if (base === null || typeof base !== "object" || quote === null || typeof quote !== "object") {
    return undefined
  }
  try {
    const liquidity = Reflect.get(raw, "liquidity")
    const volume = Reflect.get(raw, "volume")
    const txns = Reflect.get(raw, "txns")
    const txns24h = txns !== null && typeof txns === "object" ? Reflect.get(txns, "h24") : undefined
    const buys = txns24h !== null && typeof txns24h === "object" ? numberOrUndefined(Reflect.get(txns24h, "buys")) : undefined
    const sells = txns24h !== null && typeof txns24h === "object" ? numberOrUndefined(Reflect.get(txns24h, "sells")) : undefined
    const volume24h = volume !== null && typeof volume === "object"
      ? numberOrUndefined(Reflect.get(volume, "h24"))
      : undefined
    return {
      chainId: stringValue(Reflect.get(raw, "chainId"), "chainId"),
      pairAddress: stringValue(Reflect.get(raw, "pairAddress"), "pairAddress"),
      baseToken: {
        address: stringValue(Reflect.get(base, "address"), "base token address"),
        symbol: stringValue(Reflect.get(base, "symbol"), "base token symbol"),
        name: stringValue(Reflect.get(base, "name"), "base token name"),
      },
      quoteToken: {
        address: stringValue(Reflect.get(quote, "address"), "quote token address"),
        symbol: stringValue(Reflect.get(quote, "symbol"), "quote token symbol"),
        name: stringValue(Reflect.get(quote, "name"), "quote token name"),
      },
      ...(numberOrUndefined(Reflect.get(raw, "priceUsd")) === undefined ? {} : { priceUsd: numberOrUndefined(Reflect.get(raw, "priceUsd"))! }),
      ...(liquidity !== null && typeof liquidity === "object" && numberOrUndefined(Reflect.get(liquidity, "usd")) !== undefined ? { liquidityUsd: numberOrUndefined(Reflect.get(liquidity, "usd"))! } : {}),
      ...(volume24h !== undefined ? { volume24hUsd: volume24h } : {}),
      ...(numberOrUndefined(Reflect.get(raw, "fdv")) === undefined ? {} : { fdv: numberOrUndefined(Reflect.get(raw, "fdv"))! }),
      buys24h: buys ?? 0,
      sells24h: sells ?? 0,
      url: stringValue(Reflect.get(raw, "url"), "url"),
    }
  } catch {
    // Skip malformed / overlong Dex rows — one junk hit must not abort search
    return undefined
  }
}

export function parseDexScreenerPairs(payload: unknown): MarketPair[] {
  if (payload === null || typeof payload !== "object") throw new TypeError("DexScreener response must be an object")
  const pairs = Reflect.get(payload, "pairs")
  if (!Array.isArray(pairs) || pairs.length > MAX_LIST) throw new TypeError("DexScreener response has invalid pairs")
  return pairs.flatMap((raw) => {
    const pair = parseDexScreenerPair(raw)
    return pair ? [pair] : []
  })
}

async function dexFetch(fetcher: FetchLike, path: string, profile = false): Promise<MarketPair[]> {
  const response = await gatedFetch(fetcher, new URL(path, DEXSCREENER_ROOT), {
    host: "api.dexscreener.com",
    capacity: profile ? 50 : 200,
    refillPerSecond: (profile ? 50 : 200) / 60,
  })
  if (!response.ok) throw new Error(`DexScreener request failed with HTTP ${response.status}`)
  return parseDexScreenerPairs(await readJsonBody(response))
}

export function fetchDexScreenerPair(fetcher: FetchLike, chainId: string, pairAddress: string): Promise<MarketPair[]> {
  if (!SAFE_CHAIN.test(chainId) || !SAFE_PAIR.test(pairAddress)) throw new TypeError("Invalid DexScreener pair identity")
  return dexFetch(fetcher, `/latest/dex/pairs/${encodeURIComponent(chainId)}/${encodeURIComponent(pairAddress)}`)
}

export function searchDexScreener(fetcher: FetchLike, query: string): Promise<MarketPair[]> {
  if (query.trim().length < 1 || query.length > 128) throw new TypeError("DexScreener search query must be 1 to 128 characters")
  return dexFetch(fetcher, `/latest/dex/search?q=${encodeURIComponent(query)}`)
}

export function fetchDexScreenerBoosts(fetcher: FetchLike): Promise<DexBoost[]> {
  return fetchDexScreenerBoostsInternal(fetcher)
}

async function fetchDexScreenerBoostsInternal(fetcher: FetchLike): Promise<DexBoost[]> {
  const response = await gatedFetch(fetcher, new URL("/token-boosts/latest/v1", DEXSCREENER_ROOT), {
    host: "api.dexscreener.com",
    capacity: 50,
    refillPerSecond: 50 / 60,
  })
  if (!response.ok) throw new Error(`DexScreener boost request failed with HTTP ${response.status}`)
  const payload = await readJsonBody(response)
  if (!Array.isArray(payload) || payload.length > MAX_LIST) throw new TypeError("DexScreener boosts response must be an array")
  return payload.map((entry) => {
    if (entry === null || typeof entry !== "object") throw new TypeError("DexScreener boost must be an object")
    const amount = numberOrUndefined(Reflect.get(entry, "amount"))
    const totalAmount = numberOrUndefined(Reflect.get(entry, "totalAmount"))
    if (amount === undefined || totalAmount === undefined || amount < 0 || totalAmount < amount) throw new TypeError("DexScreener boost has invalid amounts")
    const description = Reflect.get(entry, "description")
    const url = Reflect.get(entry, "url")
    return {
      chainId: stringValue(Reflect.get(entry, "chainId"), "boost chainId"),
      tokenAddress: stringValue(Reflect.get(entry, "tokenAddress"), "boost tokenAddress"),
      amount,
      totalAmount,
      ...(typeof description === "string" ? { description } : {}),
      ...(typeof url === "string" ? { url } : {}),
    }
  })
}

export type CoinGeckoTrending = Readonly<{
  coins: readonly Readonly<{ id: string; name: string; symbol: string; rank?: number }>[]
  categories: readonly Readonly<{ id: string; name: string; marketCapChange24h?: number }>[]
}>

type TrendingCoin = CoinGeckoTrending["coins"][number]

function parseTrendingCoins(coins: unknown[]): TrendingCoin[] {
  return coins.map((entry) => {
    const item = entry !== null && typeof entry === "object" ? Reflect.get(entry, "item") : undefined
    if (item === null || typeof item !== "object") throw new TypeError("CoinGecko coin missing item")
    return {
      id: stringValue(Reflect.get(item, "id"), "coin id"),
      name: stringValue(Reflect.get(item, "name"), "coin name"),
      symbol: stringValue(Reflect.get(item, "symbol"), "coin symbol"),
      ...(numberOrUndefined(Reflect.get(item, "market_cap_rank")) === undefined
        ? {}
        : { rank: numberOrUndefined(Reflect.get(item, "market_cap_rank"))! }),
    }
  })
}

// Path must be relative — a leading "/" drops /api/v3 and CoinGecko 301s; gatedFetch
// uses redirect:"error", which surfaces as TypeError "fetch failed"
function coinGeckoTrendingUrl(): URL {
  return new URL("search/trending", `${COINGECKO_ROOT}/`)
}

async function fetchTrendingPayload(fetcher: FetchLike, demoKey?: string): Promise<object> {
  const key = demoKey?.trim()
  const response = await gatedFetchWithRetry(fetcher, coinGeckoTrendingUrl(), {
    ...COINGECKO_HOST_GATE,
    headers: { accept: "application/json", ...(key ? { "x-cg-demo-api-key": key } : {}) },
  })
  if (!response.ok) throw new Error(`CoinGecko trending request failed with HTTP ${response.status}`)
  const payload = await readJsonBody(response)
  if (payload === null || typeof payload !== "object") throw new TypeError("CoinGecko response must be an object")
  return payload
}

export async function fetchCoinGeckoTrending(fetcher: FetchLike, apiKey: string): Promise<CoinGeckoTrending> {
  if (!apiKey.trim()) throw new Error("CoinGecko Demo API key is required")
  const payload = await fetchTrendingPayload(fetcher, apiKey)
  const coins = Reflect.get(payload, "coins")
  const categories = Reflect.get(payload, "categories")
  if (!Array.isArray(coins) || !Array.isArray(categories) || coins.length > 100 || categories.length > 100) {
    throw new TypeError("CoinGecko response has invalid lists")
  }
  return {
    coins: parseTrendingCoins(coins),
    categories: categories.map((entry) => {
      if (entry === null || typeof entry !== "object") throw new TypeError("CoinGecko category missing object")
      const change = numberOrUndefined(Reflect.get(entry, "market_cap_change_24h"))
        ?? numberOrUndefined(Reflect.get(entry, "market_cap_1h_change"))
      return {
        id: coingeckoCategoryId(entry),
        name: stringValue(Reflect.get(entry, "name"), "category name"),
        ...(change === undefined ? {} : { marketCapChange24h: change }),
      }
    }),
  }
}

/** Trending coins only (categories need a Demo key). Shares the CoinGecko gate + retry. */
export async function fetchCoinGeckoTrendingCoins(
  fetcher: FetchLike,
  demoKey?: string,
): Promise<TrendingCoin[]> {
  const payload = await fetchTrendingPayload(fetcher, demoKey)
  const coins = Reflect.get(payload, "coins")
  if (!Array.isArray(coins) || coins.length > 100) throw new TypeError("CoinGecko response has invalid coins")
  return parseTrendingCoins(coins)
}

export type MarketAttentionFallbackItem = Readonly<{
  kind: "boost" | "new-pool"
  id: string
  name: string
  symbol?: string
  chainId?: string
}>

export type MarketAttention = Readonly<{
  coins: readonly TrendingCoin[]
  categories: CoinGeckoTrending["categories"]
  source:
    | "host.coingecko.trending"
    | "host.coingecko.trending-partial"
    | "host.market-attention.fallback"
  marketBlind: boolean
  marketBlindReason?: "coingecko-failed" | "categories-unavailable" | "fallback-only"
  statusLines: string[]
  fallbackItems?: MarketAttentionFallbackItem[]
}>

function errDetail(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 120)
}

function poolToFallbackItem(pool: GeckoPool): MarketAttentionFallbackItem {
  return { kind: "new-pool", id: pool.id, name: pool.name, chainId: pool.network }
}

/**
 * DexScreener boosts + GeckoTerminal new pools stand in for CoinGecko when it is
 * unreachable. They are paid-attention / launch signals, never category rotation,
 * so any caller must stay market-blind on this path.
 */
async function fallbackAttention(
  fetcher: FetchLike,
  statusLines: string[],
): Promise<MarketAttention> {
  const fallbackItems: MarketAttentionFallbackItem[] = []
  try {
    const boosts = await fetchDexScreenerBoosts(fetcher)
    for (const boost of boosts) {
      if (fallbackItems.length >= MAX_FALLBACK_ITEMS) break
      fallbackItems.push({
        kind: "boost",
        id: boost.tokenAddress,
        name: boost.description?.slice(0, 128) ?? boost.tokenAddress,
        chainId: boost.chainId,
      })
    }
    statusLines.push(`dexBoosts=ok items=${boosts.length}`)
  } catch (error) {
    statusLines.push(`dexBoosts=error detail=${errDetail(error)}`)
  }

  for (const network of FALLBACK_NETWORKS) {
    if (fallbackItems.length >= MAX_FALLBACK_ITEMS) break
    try {
      const pools = await fetchGeckoNewPools(fetcher, { network })
      for (const pool of pools) {
        if (fallbackItems.length >= MAX_FALLBACK_ITEMS) break
        fallbackItems.push(poolToFallbackItem(pool))
      }
      statusLines.push(`newPools:${network}=ok items=${pools.length}`)
    } catch (error) {
      statusLines.push(`newPools:${network}=error detail=${errDetail(error)}`)
    }
  }

  const reason = fallbackItems.length > 0 ? "coingecko-failed" : "fallback-only"
  statusLines.push(`marketBlind=true reason=${reason} rotationConfirmation=missing`)
  return {
    coins: [],
    categories: [],
    source: "host.market-attention.fallback",
    marketBlind: true,
    marketBlindReason: reason,
    statusLines,
    ...(fallbackItems.length > 0 ? { fallbackItems } : {}),
  }
}

/**
 * Resolve narrative market-attention with graceful degradation. Never throws for a
 * total upstream failure — returns an explicit market-blind result so the caller
 * can seal a degraded run instead of crashing.
 */
export async function fetchMarketAttentionForNarrative(
  fetcher: FetchLike,
  opts: Readonly<{ demoKey?: string }> = {},
): Promise<MarketAttention> {
  const demoKey = opts.demoKey?.trim()
  const statusLines: string[] = []

  if (demoKey) {
    try {
      const trending = await fetchCoinGeckoTrending(fetcher, demoKey)
      statusLines.push(
        `coingecko=ok coins=${trending.coins.length} categories=${trending.categories.length}`,
      )
      const blind = trending.categories.length === 0
      return {
        coins: trending.coins,
        categories: trending.categories,
        source: "host.coingecko.trending",
        marketBlind: blind,
        ...(blind ? { marketBlindReason: "categories-unavailable" as const } : {}),
        statusLines,
      }
    } catch (error) {
      statusLines.push(`coingecko=error detail=${errDetail(error)}`)
      return fallbackAttention(fetcher, statusLines)
    }
  }

  // Keyless: trending coins only, no categories — cannot confirm capital rotation
  try {
    const coins = await fetchCoinGeckoTrendingCoins(fetcher)
    statusLines.push(`coingecko=keyless coins=${coins.length} categories=unavailable`)
    statusLines.push("marketBlind=true reason=categories-unavailable rotationConfirmation=missing")
    return {
      coins,
      categories: [],
      source: "host.coingecko.trending-partial",
      marketBlind: true,
      marketBlindReason: "categories-unavailable",
      statusLines,
    }
  } catch (error) {
    statusLines.push(`coingecko=error detail=${errDetail(error)}`)
    return fallbackAttention(fetcher, statusLines)
  }
}

export type FearGreed = Readonly<{ value: number; classification: string; timestamp: number }>

export async function fetchFearGreed(fetcher: FetchLike, nowEpochSeconds: number): Promise<FearGreed> {
  if (!Number.isSafeInteger(nowEpochSeconds) || nowEpochSeconds < 0) throw new TypeError("nowEpochSeconds must be a non-negative integer")
  const response = await gatedFetch(fetcher, new URL("/fng/?limit=1&format=json", ALTERNATIVE_ROOT), {
    host: "api.alternative.me",
    capacity: 10,
    refillPerSecond: 10 / 60,
  })
  if (!response.ok) throw new Error(`Alternative.me request failed with HTTP ${response.status}`)
  const payload = await readJsonBody(response)
  const data = payload !== null && typeof payload === "object" ? Reflect.get(payload, "data") : undefined
  const item = Array.isArray(data) ? data[0] : undefined
  if (item === null || typeof item !== "object") throw new TypeError("Fear & Greed response has no reading")
  const value = numberOrUndefined(Reflect.get(item, "value"))
  const timestamp = numberOrUndefined(Reflect.get(item, "timestamp"))
  const classification = Reflect.get(item, "value_classification")
  if (
    value === undefined
    || timestamp === undefined
    || !Number.isInteger(value)
    || value < 0
    || value > 100
    || !Number.isSafeInteger(timestamp)
    || timestamp > nowEpochSeconds + 300
    || nowEpochSeconds - timestamp > 172_800
    || typeof classification !== "string"
  ) {
    throw new TypeError("Fear & Greed response has invalid or stale timestamp")
  }
  return { value, classification, timestamp }
}
