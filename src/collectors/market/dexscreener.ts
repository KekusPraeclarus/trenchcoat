import { gatedFetch, readJsonBody } from "../../lib/http.js"
import type { FetchLike } from "../market/geckoterminal.js"

export type DexPair = Readonly<{
  chainId: string
  pairAddress: string
  baseTokenAddress: string
  quoteTokenAddress: string
  liquidityUsd: number
  volume24hUsd: number
  symbol: string
}>

export async function searchPairs(
  fetcher: FetchLike,
  query: string,
): Promise<DexPair[]> {
  const url = new URL("https://api.dexscreener.com/latest/dex/search")
  url.searchParams.set("q", query)
  const response = await gatedFetch(fetcher, url, {
    host: "api.dexscreener.com",
    capacity: 180,
    refillPerSecond: 3,
    headers: { accept: "application/json" },
    timeoutMs: 10_000,
  })
  if (!response.ok) throw new Error(`DexScreener search HTTP ${response.status}`)
  const body = await readJsonBody(response) as {
    pairs?: Array<Record<string, unknown>>
  }
  return (body.pairs ?? []).slice(0, 50).map(normalizePair).filter(Boolean) as DexPair[]
}

export async function getPair(
  fetcher: FetchLike,
  chainId: string,
  pairAddress: string,
): Promise<DexPair | undefined> {
  const url = `https://api.dexscreener.com/latest/dex/pairs/${encodeURIComponent(chainId)}/${encodeURIComponent(pairAddress)}`
  const response = await gatedFetch(fetcher, url, {
    host: "api.dexscreener.com",
    capacity: 180,
    refillPerSecond: 3,
    headers: { accept: "application/json" },
    timeoutMs: 10_000,
  })
  if (!response.ok) throw new Error(`DexScreener pair HTTP ${response.status}`)
  const body = await readJsonBody(response) as { pair?: Record<string, unknown> }
  return body.pair ? normalizePair(body.pair) : undefined
}

function normalizePair(pair: Record<string, unknown>): DexPair | undefined {
  const chainId = String(pair["chainId"] ?? "")
  const pairAddress = String(pair["pairAddress"] ?? "")
  const base = pair["baseToken"] as Record<string, unknown> | undefined
  const quote = pair["quoteToken"] as Record<string, unknown> | undefined
  const liquidity = pair["liquidity"] as Record<string, unknown> | undefined
  const volume = pair["volume"] as Record<string, unknown> | undefined
  if (!chainId || !pairAddress || !base?.["address"]) return undefined
  return {
    chainId,
    pairAddress,
    baseTokenAddress: String(base["address"]),
    quoteTokenAddress: String(quote?.["address"] ?? ""),
    liquidityUsd: Number(liquidity?.["usd"] ?? 0),
    volume24hUsd: Number(volume?.["h24"] ?? 0),
    symbol: String(base["symbol"] ?? "?"),
  }
}
