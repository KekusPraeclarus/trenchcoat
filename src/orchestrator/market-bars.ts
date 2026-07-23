/**
 * Live OHLCV bar providers for outcome settlement.
 * Resolve a pool via DexScreener (metadata only), then price with GeckoTerminal OHLCV.
 * Provider failures return empty bars so settlers stay provider-pending — never invent losses.
 */

import { getChain, type ChainEntry } from "../lib/chains.js"
import { searchDexScreener, type MarketPair } from "../collectors/market/providers.js"
import {
  fetchClosedOhlcvPages,
  type FetchLike,
} from "../collectors/market/geckoterminal.js"
import type { SourceCallEvent, WalletBuyOutcome, CanonicalIdentity } from "../contracts/schemas.js"
import type { BarProvider, PriceBar } from "./observations.js"

const MAX_OHLCV_PAGES = 8
const CANDLES_PER_PAGE = 200
const POOL_CACHE = new Map<string, MarketPair | null>()

const CHAIN_FALLBACK = ["solana", "ethereum", "base", "bsc", "robinhood", "plasma", "hyperliquid"]
  .map((slug) => getChain(slug))
  .filter((c): c is ChainEntry => c !== undefined)

function chainCandidatesForHint(hint: SourceCallEvent["chainHint"]): ChainEntry[] {
  if (hint === "solana") {
    const sol = getChain("solana")
    return sol ? [sol] : []
  }
  if (hint === "evm") {
    return ["ethereum", "base", "bsc", "robinhood", "plasma", "hyperliquid"]
      .map((slug) => getChain(slug))
      .filter((c): c is ChainEntry => c !== undefined)
  }
  return CHAIN_FALLBACK
}

function pickBestPair(pairs: readonly MarketPair[], chain?: ChainEntry): MarketPair | undefined {
  const filtered = chain
    ? pairs.filter((p) => p.chainId === chain.dexscreenerChainId)
    : [...pairs]
  return filtered
    .slice()
    .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))[0]
}

async function resolvePool(
  fetcher: FetchLike,
  tokenAddress: string,
  chains: readonly ChainEntry[],
): Promise<{ chain: ChainEntry; pair: MarketPair } | undefined> {
  const cacheKey = `${chains.map((c) => c.slug).join(",")}:${tokenAddress}`
  if (POOL_CACHE.has(cacheKey)) {
    const cached = POOL_CACHE.get(cacheKey)
    if (!cached) return undefined
    const chain = getChain(
      CHAIN_FALLBACK.find((c) => c.dexscreenerChainId === cached.chainId)?.slug
        ?? chains.find((c) => c.dexscreenerChainId === cached.chainId)?.slug
        ?? "",
    )
    if (!chain) return undefined
    return { chain, pair: cached }
  }

  try {
    const pairs = await searchDexScreener(fetcher, tokenAddress)
    for (const chain of chains) {
      const best = pickBestPair(pairs, chain)
      if (best) {
        POOL_CACHE.set(cacheKey, best)
        return { chain, pair: best }
      }
    }
    const any = pickBestPair(pairs)
    if (any) {
      const chain = CHAIN_FALLBACK.find((c) => c.dexscreenerChainId === any.chainId)
        ?? chains.find((c) => c.dexscreenerChainId === any.chainId)
      if (chain) {
        POOL_CACHE.set(cacheKey, any)
        return { chain, pair: any }
      }
    }
  } catch {
    // Leave empty so settlement records provider-pending
  }
  POOL_CACHE.set(cacheKey, null)
  return undefined
}

function candlesToBars(
  candles: readonly { startTime: number; open: number; high?: number }[],
): readonly PriceBar[] {
  return candles.map((c) => ({
    ts: new Date(c.startTime * 1000).toISOString(),
    open: c.open,
    ...(c.high !== undefined && Number.isFinite(c.high) ? { high: c.high } : {}),
    finalized: true,
  }))
}

async function loadBarsForToken(
  fetcher: FetchLike,
  tokenAddress: string,
  chains: readonly ChainEntry[],
  pairAddress: string | undefined,
  nowIso: string,
  horizonHours: number,
): Promise<readonly PriceBar[]> {
  const asOf = Math.floor(Date.parse(nowIso) / 1000)
  if (!Number.isFinite(asOf)) return []

  let chain: ChainEntry | undefined
  let pool = pairAddress

  if (pool && chains[0]) {
    chain = chains[0]
  } else {
    const resolved = await resolvePool(fetcher, tokenAddress, chains)
    if (!resolved) return []
    chain = resolved.chain
    pool = resolved.pair.pairAddress
  }
  if (!chain || !pool) return []

  try {
    // Cover event→horizon plus a buffer for P0 selection after the event
    const needHours = Math.max(horizonHours + 24, 48)
    const needCandles = Math.ceil((needHours * 60) / 5) + 12
    const limit = Math.min(CANDLES_PER_PAGE, Math.max(100, needCandles))
    const maxPages = needHours >= 168 ? 24 : MAX_OHLCV_PAGES
    const candles = await fetchClosedOhlcvPages(
      fetcher,
      {
        network: chain.geckoterminalNetwork,
        poolAddress: pool,
        aggregateMinutes: 5,
        limit,
      },
      asOf,
      maxPages,
    )
    return candlesToBars(candles)
  } catch {
    return []
  }
}

export function createLiveSourceBarProvider(
  fetcher: FetchLike = fetch,
  nowIso: () => string = () => new Date().toISOString(),
): BarProvider<SourceCallEvent> {
  return async (event, horizonHours) => {
    const chains = event.pairAddress && event.tokenId?.includes(":")
      ? (() => {
        const slug = event.tokenId!.split(":")[0]!
        const chain = getChain(slug)
        return chain ? [chain] : chainCandidatesForHint(event.chainHint)
      })()
      : chainCandidatesForHint(event.chainHint)
    return loadBarsForToken(
      fetcher,
      event.rawAddress,
      chains,
      event.pairAddress,
      nowIso(),
      horizonHours,
    )
  }
}

export function createLiveWalletBarProvider(
  fetcher: FetchLike = fetch,
  nowIso: () => string = () => new Date().toISOString(),
): BarProvider<WalletBuyOutcome> {
  return async (outcome, horizonHours) => {
    const chain = getChain(outcome.chain)
    if (!chain) return []
    return loadBarsForToken(
      fetcher,
      outcome.tokenAddress,
      [chain],
      undefined,
      nowIso(),
      horizonHours,
    )
  }
}

export function createLiveIdentityBarProvider(
  fetcher: FetchLike = fetch,
  nowIso: () => string = () => new Date().toISOString(),
): BarProvider<CanonicalIdentity> {
  return async (identity, horizonHours) => {
    const chain = getChain(identity.chain)
    if (!chain) return []
    return loadBarsForToken(
      fetcher,
      identity.tokenAddress,
      [chain],
      identity.pairAddress,
      nowIso(),
      horizonHours,
    )
  }
}

/** Test helper — clear Dex pool cache between cases */
export function clearMarketBarPoolCache(): void {
  POOL_CACHE.clear()
}
