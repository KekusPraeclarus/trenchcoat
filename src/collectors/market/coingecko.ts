import type { FetchLike } from "./geckoterminal.js"
import { fetchCoinGeckoTrendingCoins } from "./providers.js"

// Thin re-export so every CoinGecko caller shares one gate + retry config (INV-R1/R3)
// and cannot race a first-wins gate with mismatched capacity/budget.
export async function fetchTrendingCoins(
  fetcher: FetchLike,
  demoKey?: string,
): Promise<Array<{ id: string; name: string; symbol: string }>> {
  const coins = await fetchCoinGeckoTrendingCoins(fetcher, demoKey)
  return coins.map((coin) => ({ id: coin.id, name: coin.name, symbol: coin.symbol }))
}
