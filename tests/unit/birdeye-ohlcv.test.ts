import { describe, expect, it, vi } from "vitest"
import {
  fetchBirdeyeOhlcv,
  parseBirdeyeOhlcv,
} from "../../src/collectors/market/birdeye.js"
import type { FetchLike } from "../../src/collectors/market/geckoterminal.js"

const TOKEN = "So11111111111111111111111111111111111111112"

describe("Birdeye OHLCV", () => {
  it("parses v3 items into closed candles", () => {
    const candles = parseBirdeyeOhlcv({
      data: {
        items: [
          { unixTime: 900, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
          { unixTime: 1800, o: 1.5, h: 2.5, l: 1, c: 2, v: 20 },
        ],
      },
    }, "15m", 2_700)

    expect(candles.map((c) => c.startTime)).toEqual([900, 1800])
  })

  it("rejects malformed payloads", () => {
    expect(() => parseBirdeyeOhlcv({ data: {} }, "15m", 10_000))
      .toThrow(/no OHLCV items/u)
  })

  it("fetches with chain and api key headers", async () => {
    const fetcher = vi.fn<FetchLike>(async () => new Response(JSON.stringify({
      data: {
        items: [
          { unixTime: 900, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
          { unixTime: 1800, o: 1.5, h: 2.5, l: 1, c: 2, v: 20 },
        ],
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }))

    const candles = await fetchBirdeyeOhlcv({
      fetcher,
      tokenAddress: TOKEN,
      chain: "solana",
      asOfEpochSeconds: 2_700,
      apiKey: "be-key",
    })

    expect(candles).toHaveLength(2)
    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers)
    expect(headers.get("X-API-KEY")).toBe("be-key")
    expect(headers.get("x-chain")).toBe("solana")
  })

  it("fetches ethereum OHLCV with x-chain ethereum", async () => {
    const fetcher = vi.fn<FetchLike>(async () => new Response(JSON.stringify({
      data: {
        items: [
          { unixTime: 900, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
          { unixTime: 1800, o: 1.5, h: 2.5, l: 1, c: 2, v: 20 },
        ],
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }))

    await fetchBirdeyeOhlcv({
      fetcher,
      tokenAddress: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
      chain: "ethereum",
      asOfEpochSeconds: 2_700,
      apiKey: "be-key",
    })

    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("x-chain")).toBe("ethereum")
  })
})
