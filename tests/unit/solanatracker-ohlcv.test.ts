import { describe, expect, it, vi } from "vitest"
import {
  fetchSolanaTrackerOhlcv,
  parseSolanaTrackerOhlcv,
} from "../../src/collectors/market/solanatracker.js"
import type { FetchLike } from "../../src/collectors/market/geckoterminal.js"

const TOKEN = "So11111111111111111111111111111111111111112"

describe("SolanaTracker OHLCV", () => {
  it("parses closed candles and drops the open bar", () => {
    const candles = parseSolanaTrackerOhlcv({
      ohlcv: [
        { time: 900, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
        { time: 1800, open: 1.5, high: 2.5, low: 1, close: 2, volume: 20 },
      ],
    }, "15m", 2_700)

    expect(candles.map((c) => c.startTime)).toEqual([900, 1800])
  })

  it("rejects malformed payloads", () => {
    expect(() => parseSolanaTrackerOhlcv({ bad: true }, "15m", 10_000))
      .toThrow(/no OHLCV array/u)
  })

  it("fetches with the api key header", async () => {
    const fetcher = vi.fn<FetchLike>(async () => new Response(JSON.stringify({
      ohlcv: [
        { time: 900, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
        { time: 1800, open: 1.5, high: 2.5, low: 1, close: 2, volume: 20 },
      ],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }))

    const candles = await fetchSolanaTrackerOhlcv({
      fetcher,
      tokenAddress: TOKEN,
      asOfEpochSeconds: 2_700,
      apiKey: "st-key",
    })

    expect(candles).toHaveLength(2)
    const init = fetcher.mock.calls[0]?.[1]
    expect(new Headers(init?.headers).get("x-api-key")).toBe("st-key")
  })
})
