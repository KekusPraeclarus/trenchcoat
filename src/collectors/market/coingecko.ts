import { gatedFetch, readJsonBody } from "../../lib/http.js"
import type { FetchLike } from "../market/geckoterminal.js"

export async function fetchTrendingCoins(
  fetcher: FetchLike,
  demoKey?: string,
): Promise<Array<{ id: string; name: string; symbol: string }>> {
  const url = new URL("https://api.coingecko.com/api/v3/search/trending")
  const headers: Record<string, string> = { accept: "application/json" }
  if (demoKey) headers["x-cg-demo-api-key"] = demoKey
  const response = await gatedFetch(fetcher, url, {
    host: "api.coingecko.com",
    capacity: 20,
    refillPerSecond: 0.3,
    monthlyBudget: 8_000,
    headers,
    timeoutMs: 15_000,
  })
  if (!response.ok) throw new Error(`CoinGecko HTTP ${response.status}`)
  const body = await readJsonBody(response) as {
    coins?: Array<{ item?: { id?: string; name?: string; symbol?: string } }>
  }
  return (body.coins ?? []).map((c) => ({
    id: String(c.item?.id ?? ""),
    name: String(c.item?.name ?? ""),
    symbol: String(c.item?.symbol ?? ""),
  })).filter((c) => c.id)
}
