import { describe, expect, it } from "vitest"

import { computeWilderRsi } from "../src/collectors/market/indicators.js"
import type { OhlcvCandle } from "../src/collectors/market/geckoterminal.js"

const INTERVAL = 3_600

function candlesFromCloses(
  closes: readonly number[],
  volume = 1,
): OhlcvCandle[] {
  return closes.map((close, index) => ({
    startTime: index * INTERVAL,
    open: close,
    high: close,
    low: close,
    close,
    volume,
  }))
}

describe("Wilder RSI", () => {
  it("matches the canonical Wilder example and records the prior value", () => {
    const result = computeWilderRsi(candlesFromCloses([
      44.34,
      44.09,
      44.15,
      43.61,
      44.33,
      44.83,
      45.10,
      45.42,
      45.84,
      46.08,
      45.89,
      46.03,
      45.61,
      46.28,
      46.28,
      46.00,
    ]), INTERVAL)

    expect(result.valid).toBe(true)
    if (!result.valid) {
      return
    }

    expect(result.previous).toBeCloseTo(70.4641, 3)
    expect(result.value).toBeCloseTo(66.2496, 3)
    expect(result.delta).toBeCloseTo(-4.2145, 3)
  })

  it.each([
    ["flat", Array.from({ length: 16 }, () => 10), 50],
    ["rising", Array.from({ length: 16 }, (_, index) => 10 + index), 100],
    ["falling", Array.from({ length: 16 }, (_, index) => 30 - index), 0],
  ])("handles the %s zero-denominator edge case", (_name, closes, expected) => {
    const result = computeWilderRsi(candlesFromCloses(closes), INTERVAL)
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.value).toBe(expected)
    }
  })

  it("fails closed on candle gaps", () => {
    const candles = candlesFromCloses(Array.from({ length: 16 }, (_, index) => 10 + index))
    const withGap = candles.map((candle, index) => (
      index === 8
        ? { ...candle, startTime: candle.startTime + INTERVAL }
        : candle
    ))

    expect(computeWilderRsi(withGap, INTERVAL)).toMatchObject({
      valid: false,
      reason: "gap",
    })
  })

  it("fails closed when too few recent bars traded", () => {
    const candles = candlesFromCloses(Array.from({ length: 16 }, (_, index) => 10 + index))
      .map((candle, index) => ({ ...candle, volume: index < 10 ? 1 : 0 }))

    expect(computeWilderRsi(candles, INTERVAL)).toMatchObject({
      valid: false,
      reason: "insufficient-active-bars",
    })
  })

  it("produces the same input hash for the same immutable series", () => {
    const candles = candlesFromCloses(Array.from({ length: 16 }, (_, index) => 10 + index))
    expect(computeWilderRsi(candles, INTERVAL).inputHash).toBe(
      computeWilderRsi([...candles], INTERVAL).inputHash,
    )
  })
})
