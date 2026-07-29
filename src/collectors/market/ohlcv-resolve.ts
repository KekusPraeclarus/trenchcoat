import {
  fetchClosedOhlcvPages,
  type FetchLike,
  type OhlcvCandle,
} from "./geckoterminal.js"
import { fetchSolanaTrackerOhlcv } from "./solanatracker.js"
import { fetchBirdeyeOhlcv, birdeyeChainForSlug } from "./birdeye.js"

export type OhlcvSource = "gecko" | "solanatracker" | "birdeye"

export type OhlcvPagesResult = Readonly<{
  candles: OhlcvCandle[]
  source: OhlcvSource
}>

const RETRYABLE_HTTP = /HTTP (429|5\d\d)/u

export function isRetryableOhlcvError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (RETRYABLE_HTTP.test(error.message)) return true
  const name = error.name
  if (name === "TimeoutError" || name === "AbortError") return true
  return error instanceof TypeError && error.message === "fetch failed"
}

function solanaTrackerKey(): string | undefined {
  return process.env["SOLANATRACKER_API_KEY"]?.trim() || undefined
}

function birdeyeKey(): string | undefined {
  return process.env["BIRDEYE_API_KEY"]?.trim() || undefined
}

function intervalTypeForAggregate(minutes: 1 | 5 | 15): string {
  if (minutes === 15) return "15m"
  if (minutes === 5) return "5m"
  return "1m"
}

async function fetchGeckoPages(args: Readonly<{
  fetcher: FetchLike
  network: string
  poolAddress: string
  aggregateMinutes: 1 | 5 | 15
  limit: number
  asOfEpochSeconds: number
  maxPages: number
}>): Promise<OhlcvCandle[]> {
  return fetchClosedOhlcvPages(
    args.fetcher,
    {
      network: args.network,
      poolAddress: args.poolAddress,
      aggregateMinutes: args.aggregateMinutes,
      limit: args.limit,
    },
    args.asOfEpochSeconds,
    args.maxPages,
  )
}

/** Solana: SolanaTracker preferred, Birdeye last resort. */
async function fetchSolanaFallbacks(args: Readonly<{
  fetcher: FetchLike
  tokenAddress: string
  asOfEpochSeconds: number
  intervalType?: string
}>): Promise<OhlcvPagesResult> {
  const intervalType = args.intervalType ?? "15m"
  const timeTo = args.asOfEpochSeconds
  const timeFrom = timeTo - 14 * 86_400
  let lastError: unknown

  const stKey = solanaTrackerKey()
  if (stKey) {
    try {
      const candles = await fetchSolanaTrackerOhlcv({
        fetcher: args.fetcher,
        tokenAddress: args.tokenAddress,
        intervalType,
        asOfEpochSeconds: args.asOfEpochSeconds,
        apiKey: stKey,
        timeFrom,
        timeTo,
      })
      if (candles.length > 0) return { candles, source: "solanatracker" }
    } catch (error) {
      lastError = error
    }
  }

  const beKey = birdeyeKey()
  if (beKey) {
    try {
      const candles = await fetchBirdeyeOhlcv({
        fetcher: args.fetcher,
        tokenAddress: args.tokenAddress,
        chain: "solana",
        intervalType,
        asOfEpochSeconds: args.asOfEpochSeconds,
        apiKey: beKey,
        timeFrom,
        timeTo,
      })
      if (candles.length > 0) return { candles, source: "birdeye" }
    } catch (error) {
      lastError = error
    }
  }

  if (lastError instanceof Error) throw lastError
  throw new Error("Solana OHLCV fallback exhausted with no candles")
}

/** Non-Solana: Birdeye only (SolanaTracker is Solana-exclusive). */
async function fetchNonSolanaBirdeyeFallback(args: Readonly<{
  fetcher: FetchLike
  chain: string
  tokenAddress: string
  asOfEpochSeconds: number
  intervalType?: string
}>): Promise<OhlcvPagesResult> {
  const beChain = birdeyeChainForSlug(args.chain)
  if (!beChain) {
    throw new Error(`Birdeye OHLCV unsupported for chain ${args.chain}`)
  }
  const beKey = birdeyeKey()
  if (!beKey) {
    throw new Error("Birdeye OHLCV fallback requires BIRDEYE_API_KEY")
  }
  const intervalType = args.intervalType ?? "15m"
  const timeTo = args.asOfEpochSeconds
  const timeFrom = timeTo - 14 * 86_400
  const candles = await fetchBirdeyeOhlcv({
    fetcher: args.fetcher,
    tokenAddress: args.tokenAddress,
    chain: beChain,
    intervalType,
    asOfEpochSeconds: args.asOfEpochSeconds,
    apiKey: beKey,
    timeFrom,
    timeTo,
  })
  if (candles.length > 0) return { candles, source: "birdeye" }
  throw new Error("Birdeye OHLCV fallback returned no candles")
}

/**
 * Primary Gecko pool OHLCV.
 * Solana: retryable failure → SolanaTracker (preferred) → Birdeye.
 * Other networks: retryable failure → Birdeye only (when chain is supported).
 */
export async function fetchSolanaAwareOhlcvPages(args: Readonly<{
  fetcher: FetchLike
  chain: string
  tokenAddress: string
  network: string
  poolAddress: string
  aggregateMinutes: 1 | 5 | 15
  limit: number
  asOfEpochSeconds: number
  maxPages: number
}>): Promise<OhlcvPagesResult> {
  const intervalType = intervalTypeForAggregate(args.aggregateMinutes)

  if (args.chain === "solana") {
    try {
      const candles = await fetchGeckoPages(args)
      if (candles.length > 0) return { candles, source: "gecko" }
    } catch (error) {
      if (!isRetryableOhlcvError(error)) throw error
      if (!solanaTrackerKey() && !birdeyeKey()) throw error
      return fetchSolanaFallbacks({
        fetcher: args.fetcher,
        tokenAddress: args.tokenAddress,
        asOfEpochSeconds: args.asOfEpochSeconds,
        intervalType,
      })
    }

    if (solanaTrackerKey() || birdeyeKey()) {
      return fetchSolanaFallbacks({
        fetcher: args.fetcher,
        tokenAddress: args.tokenAddress,
        asOfEpochSeconds: args.asOfEpochSeconds,
        intervalType,
      })
    }
    return { candles: [], source: "gecko" }
  }

  try {
    const candles = await fetchGeckoPages(args)
    if (candles.length > 0) return { candles, source: "gecko" }
  } catch (error) {
    if (!isRetryableOhlcvError(error)) throw error
    if (!birdeyeKey() || !birdeyeChainForSlug(args.chain)) throw error
    return fetchNonSolanaBirdeyeFallback({
      fetcher: args.fetcher,
      chain: args.chain,
      tokenAddress: args.tokenAddress,
      asOfEpochSeconds: args.asOfEpochSeconds,
      intervalType,
    })
  }

  if (birdeyeKey() && birdeyeChainForSlug(args.chain)) {
    return fetchNonSolanaBirdeyeFallback({
      fetcher: args.fetcher,
      chain: args.chain,
      tokenAddress: args.tokenAddress,
      asOfEpochSeconds: args.asOfEpochSeconds,
      intervalType,
    })
  }

  return { candles: [], source: "gecko" }
}
