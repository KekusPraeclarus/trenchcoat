import { describe, expect, it, vi } from "vitest"

import {
  buildGeckoOhlcvUrl,
  fetchClosedOhlcv,
  firstExecutionCandle,
  nextBeforeTimestamp,
  parseClosedOhlcv,
  type FetchLike,
} from "../src/collectors/market/geckoterminal.js"

function payload(candles: unknown[]) {
  return {
    data: {
      attributes: {
        ohlcv_list: candles,
      },
    },
  }
}

describe("GeckoTerminal OHLCV semantics", () => {
  it("drops the current open candle and sorts closed candles ascending", () => {
    const result = parseClosedOhlcv(payload([
      [900, 12, 14, 11, 13, 20],
      [600, 10, 13, 9, 12, 30],
      [300, 9, 11, 8, 10, 40],
    ]), 300, 1_000)

    expect(result.map((candle) => candle.startTime)).toEqual([300, 600])
  })

  it("treats before_timestamp pagination as inclusive", () => {
    expect(nextBeforeTimestamp(600, 300)).toBe(300)
  })

  it("selects the first candle starting after an event", () => {
    const candles = parseClosedOhlcv(payload([
      [900, 12, 14, 11, 13, 20],
      [600, 10, 13, 9, 12, 30],
    ]), 300, 1_200)

    expect(firstExecutionCandle(candles, 601)?.startTime).toBe(900)
    expect(firstExecutionCandle(candles, 600)?.startTime).toBe(600)
  })

  it("rejects malformed, unaligned, and conflicting candles", () => {
    expect(() => parseClosedOhlcv(payload([
      [301, 9, 11, 8, 10, 40],
    ]), 300, 1_000)).toThrow(/aligned/u)

    expect(() => parseClosedOhlcv(payload([
      [300, 9, 11, 8, 10, 40],
      [300, 9, 12, 8, 10, 40],
    ]), 300, 1_000)).toThrow(/Conflicting/u)
  })

  it("rejects path injection in network and pool identifiers", () => {
    expect(() => buildGeckoOhlcvUrl({
      network: "../eth",
      poolAddress: "safe",
      aggregateMinutes: 5,
      limit: 10,
    })).toThrow(/network/u)

    expect(() => buildGeckoOhlcvUrl({
      network: "eth",
      poolAddress: "pool/../../secret",
      aggregateMinutes: 5,
      limit: 10,
    })).toThrow(/address/u)
  })

  it("sets the version header and rejects non-JSON responses", async () => {
    const fetcher = vi.fn<FetchLike>(async () => new Response("not json", {
      status: 200,
      headers: { "content-type": "text/html" },
    }))

    await expect(fetchClosedOhlcv(fetcher, {
      network: "eth",
      poolAddress: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
      aggregateMinutes: 5,
      limit: 10,
    }, 1_000)).rejects.toThrow(/non-JSON/u)

    expect(fetcher).toHaveBeenCalledOnce()
    const init = fetcher.mock.calls[0]?.[1]
    expect(new Headers(init?.headers).get("accept")).toBe(
      "application/json;version=20230302",
    )
    expect(init?.redirect).toBe("error")
  })

  it("retries HTTP 429 then succeeds on the next attempt", async () => {
    let calls = 0
    const fetcher = vi.fn<FetchLike>(async () => {
      calls += 1
      if (calls === 1) {
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "0" },
        })
      }
      return new Response(JSON.stringify(payload([
        [900, 10, 13, 9, 12, 30],
        [600, 9, 11, 8, 10, 40],
      ])), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })

    const candles = await fetchClosedOhlcv(fetcher, {
      network: "eth",
      poolAddress: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
      aggregateMinutes: 5,
      limit: 10,
    }, 2_000)

    expect(calls).toBe(2)
    expect(candles.map((c) => c.startTime)).toEqual([600, 900])
  })

  it("throws when HTTP 429 is exhausted", async () => {
    const fetcher = vi.fn<FetchLike>(async () => new Response("rate limited", {
      status: 429,
      headers: { "retry-after": "0" },
    }))

    await expect(fetchClosedOhlcv(fetcher, {
      network: "eth",
      poolAddress: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
      aggregateMinutes: 5,
      limit: 10,
    }, 2_000)).rejects.toThrow(/HTTP 429/u)

    expect(fetcher).toHaveBeenCalledTimes(3)
  }, 15_000)
})
