import { gatedFetch, readJsonBody } from "../../lib/http.js"
import type { FetchLike } from "./geckoterminal.js"

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

export function parseDexScreenerPairs(payload: unknown): MarketPair[] {
  if (payload === null || typeof payload !== "object") throw new TypeError("DexScreener response must be an object")
  const pairs = Reflect.get(payload, "pairs")
  if (!Array.isArray(pairs) || pairs.length > MAX_LIST) throw new TypeError("DexScreener response has invalid pairs")
  return pairs.map((raw) => {
    if (raw === null || typeof raw !== "object") throw new TypeError("DexScreener pair must be an object")
    const base = Reflect.get(raw, "baseToken")
    const quote = Reflect.get(raw, "quoteToken")
    const liquidity = Reflect.get(raw, "liquidity")
    const txns = Reflect.get(raw, "txns")
    const txns24h = txns !== null && typeof txns === "object" ? Reflect.get(txns, "h24") : undefined
    const buys = txns24h !== null && typeof txns24h === "object" ? numberOrUndefined(Reflect.get(txns24h, "buys")) : undefined
    const sells = txns24h !== null && typeof txns24h === "object" ? numberOrUndefined(Reflect.get(txns24h, "sells")) : undefined
    if (base === null || typeof base !== "object" || quote === null || typeof quote !== "object") throw new TypeError("DexScreener pair is missing tokens")
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
      ...(numberOrUndefined(Reflect.get(raw, "fdv")) === undefined ? {} : { fdv: numberOrUndefined(Reflect.get(raw, "fdv"))! }),
      buys24h: buys ?? 0,
      sells24h: sells ?? 0,
      url: stringValue(Reflect.get(raw, "url"), "url"),
    }
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

export async function fetchCoinGeckoTrending(fetcher: FetchLike, apiKey: string): Promise<CoinGeckoTrending> {
  if (!apiKey.trim()) throw new Error("CoinGecko Demo API key is required")
  const response = await gatedFetch(fetcher, new URL("/search/trending", COINGECKO_ROOT), {
    host: "api.coingecko.com",
    capacity: 25,
    refillPerSecond: 25 / 60,
    monthlyBudget: 10_000,
    headers: { "x-cg-demo-api-key": apiKey },
  })
  if (!response.ok) throw new Error(`CoinGecko trending request failed with HTTP ${response.status}`)
  const payload = await readJsonBody(response)
  if (payload === null || typeof payload !== "object") throw new TypeError("CoinGecko response must be an object")
  const coins = Reflect.get(payload, "coins")
  const categories = Reflect.get(payload, "categories")
  if (!Array.isArray(coins) || !Array.isArray(categories) || coins.length > 100 || categories.length > 100) {
    throw new TypeError("CoinGecko response has invalid lists")
  }
  return {
    coins: coins.map((entry) => {
      const item = entry !== null && typeof entry === "object" ? Reflect.get(entry, "item") : undefined
      if (item === null || typeof item !== "object") throw new TypeError("CoinGecko coin missing item")
      return { id: stringValue(Reflect.get(item, "id"), "coin id"), name: stringValue(Reflect.get(item, "name"), "coin name"), symbol: stringValue(Reflect.get(item, "symbol"), "coin symbol"), ...(numberOrUndefined(Reflect.get(item, "market_cap_rank")) === undefined ? {} : { rank: numberOrUndefined(Reflect.get(item, "market_cap_rank"))! }) }
    }),
    categories: categories.map((entry) => {
      if (entry === null || typeof entry !== "object") throw new TypeError("CoinGecko category missing object")
      return { id: stringValue(Reflect.get(entry, "id"), "category id"), name: stringValue(Reflect.get(entry, "name"), "category name"), ...(numberOrUndefined(Reflect.get(entry, "market_cap_change_24h")) === undefined ? {} : { marketCapChange24h: numberOrUndefined(Reflect.get(entry, "market_cap_change_24h"))! }) }
    }),
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
