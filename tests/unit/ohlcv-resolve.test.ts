import { afterEach, describe, expect, it, vi } from "vitest"
import {
  fetchSolanaAwareOhlcvPages,
  isRetryableOhlcvError,
} from "../../src/collectors/market/ohlcv-resolve.js"
import type { FetchLike } from "../../src/collectors/market/geckoterminal.js"

const TOKEN = "So11111111111111111111111111111111111111112"
const POOL = "So11111111111111111111111111111111111111112"

function geckoOk() {
  return new Response(JSON.stringify({
    data: { attributes: { ohlcv_list: [[900, 1, 2, 0.5, 1.5, 10], [1800, 1.5, 2.5, 1, 2, 20]] } },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function stOk() {
  return new Response(JSON.stringify({
    ohlcv: [
      { time: 900, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
      { time: 1800, open: 1.5, high: 2.5, low: 1, close: 2, volume: 20 },
    ],
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function beOk() {
  return new Response(JSON.stringify({
    data: {
      items: [
        { unixTime: 900, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
        { unixTime: 1800, o: 1.5, h: 2.5, l: 1, c: 2, v: 20 },
      ],
    },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

describe("fetchSolanaAwareOhlcvPages", () => {
  const env = { ...process.env }

  afterEach(() => {
    process.env = { ...env }
  })

  it("uses gecko for non-solana when gecko succeeds", async () => {
    const fetcher = vi.fn(async () => geckoOk())
    const result = await fetchSolanaAwareOhlcvPages({
      fetcher,
      chain: "ethereum",
      tokenAddress: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
      network: "eth",
      poolAddress: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
      aggregateMinutes: 15,
      limit: 100,
      asOfEpochSeconds: 2_700,
      maxPages: 1,
    })
    expect(result.source).toBe("gecko")
    expect(result.candles.length).toBeGreaterThan(0)
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it("falls back to Birdeye for non-solana after gecko 429", async () => {
    process.env["BIRDEYE_API_KEY"] = "be-key"
    process.env["SOLANATRACKER_API_KEY"] = "st-key"
    const fetcher = vi.fn<FetchLike>(async (input) => {
      const href = String(input)
      if (href.includes("geckoterminal")) {
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "0" },
        })
      }
      if (href.includes("birdeye")) return beOk()
      throw new Error(`unexpected url ${href}`)
    })

    const result = await fetchSolanaAwareOhlcvPages({
      fetcher,
      chain: "ethereum",
      tokenAddress: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
      network: "eth",
      poolAddress: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
      aggregateMinutes: 15,
      limit: 100,
      asOfEpochSeconds: 2_700,
      maxPages: 1,
    })

    expect(result.source).toBe("birdeye")
    expect(fetcher.mock.calls.some(([u]) => String(u).includes("solanatracker"))).toBe(false)
    const beCall = fetcher.mock.calls.find(([u]) => String(u).includes("birdeye"))
    expect(new Headers(beCall?.[1]?.headers).get("x-chain")).toBe("ethereum")
  }, 15_000)

  it("falls back to SolanaTracker after gecko 429", async () => {
    process.env["SOLANATRACKER_API_KEY"] = "st-key"
    let calls = 0
    const fetcher = vi.fn<FetchLike>(async (input) => {
      calls += 1
      const href = String(input)
      if (href.includes("geckoterminal")) {
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "0" },
        })
      }
      if (href.includes("solanatracker")) return stOk()
      throw new Error(`unexpected url ${href}`)
    })

    const result = await fetchSolanaAwareOhlcvPages({
      fetcher,
      chain: "solana",
      tokenAddress: TOKEN,
      network: "solana",
      poolAddress: POOL,
      aggregateMinutes: 15,
      limit: 100,
      asOfEpochSeconds: 2_700,
      maxPages: 1,
    })

    expect(result.source).toBe("solanatracker")
    expect(result.candles.length).toBeGreaterThan(0)
    expect(fetcher.mock.calls.some(([u]) => String(u).includes("solanatracker"))).toBe(true)
    expect(fetcher.mock.calls.some(([u]) => String(u).includes("birdeye"))).toBe(false)
    expect(calls).toBeGreaterThan(1)
  }, 15_000)

  it("falls back to Birdeye when gecko and SolanaTracker fail", async () => {
    process.env["SOLANATRACKER_API_KEY"] = "st-key"
    process.env["BIRDEYE_API_KEY"] = "be-key"
    const fetcher = vi.fn<FetchLike>(async (input) => {
      const href = String(input)
      if (href.includes("geckoterminal") || href.includes("solanatracker")) {
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "0" },
        })
      }
      if (href.includes("birdeye")) return beOk()
      throw new Error(`unexpected url ${href}`)
    })

    const result = await fetchSolanaAwareOhlcvPages({
      fetcher,
      chain: "solana",
      tokenAddress: TOKEN,
      network: "solana",
      poolAddress: POOL,
      aggregateMinutes: 15,
      limit: 100,
      asOfEpochSeconds: 2_700,
      maxPages: 1,
    })

    expect(result.source).toBe("birdeye")
    expect(result.candles.length).toBeGreaterThan(0)
  }, 15_000)

  it("throws when solana gecko fails and no fallback keys are set", async () => {
    delete process.env["SOLANATRACKER_API_KEY"]
    delete process.env["BIRDEYE_API_KEY"]
    const fetcher = vi.fn(async () => new Response("rate limited", {
      status: 429,
      headers: { "retry-after": "0" },
    }))

    await expect(fetchSolanaAwareOhlcvPages({
      fetcher,
      chain: "solana",
      tokenAddress: TOKEN,
      network: "solana",
      poolAddress: POOL,
      aggregateMinutes: 15,
      limit: 100,
      asOfEpochSeconds: 2_700,
      maxPages: 1,
    })).rejects.toThrow(/HTTP 429/u)
  }, 15_000)
})

describe("isRetryableOhlcvError", () => {
  it("classifies retryable HTTP and network errors", () => {
    expect(isRetryableOhlcvError(new Error("GeckoTerminal OHLCV request failed with HTTP 429"))).toBe(true)
    expect(isRetryableOhlcvError(new Error("GeckoTerminal OHLCV request failed with HTTP 503"))).toBe(true)
    expect(isRetryableOhlcvError(new TypeError("fetch failed"))).toBe(true)
    expect(isRetryableOhlcvError(new Error("GeckoTerminal OHLCV request failed with HTTP 404"))).toBe(false)
  })
})
