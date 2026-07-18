import { describe, expect, it } from "vitest"
import { fetchCoinGeckoTrending } from "../../src/collectors/market/providers.js"

describe("fetchCoinGeckoTrending URL", () => {
  it("requests /api/v3/search/trending not a redirecting root path", async () => {
    const seen: string[] = []
    const fetcher: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input)
      seen.push(url)
      return new Response(
        JSON.stringify({
          coins: [{ item: { id: "bitcoin", name: "Bitcoin", symbol: "btc", market_cap_rank: 1 } }],
          categories: [{
            id: 102120914,
            name: "Robinhood Chain Meme",
            slug: "robinhood-chain-meme",
            market_cap_1h_change: 2.5,
          }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }
    const result = await fetchCoinGeckoTrending(fetcher, "demo-key")
    expect(seen).toEqual(["https://api.coingecko.com/api/v3/search/trending"])
    expect(result.coins).toHaveLength(1)
    expect(result.categories).toEqual([{
      id: "robinhood-chain-meme",
      name: "Robinhood Chain Meme",
      marketCapChange24h: 2.5,
    }])
  })
})
