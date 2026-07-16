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
})
