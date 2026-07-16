import { describe, expect, it } from "vitest"
import { chartManifest, renderChartPng, renderChartSvg } from "../../src/charts/render.js"

const candles = [1, 2, 3].map((close, index) => ({
  startTime: index * 300,
  open: close,
  high: close + 1,
  low: close - 1,
  close,
  volume: 1,
}))

describe("offline charts", () => {
  it("renders deterministic SVG and PNG without network", () => {
    const svg = renderChartSvg(candles, 300)
    const first = renderChartPng(candles, 300)
    const second = renderChartPng(candles, 300)
    expect(svg.startsWith("<svg")).toBe(true)
    expect(first.subarray(1, 4).toString()).toBe("PNG")
    expect(first.equals(second)).toBe(true)
  })

  it("pins candle cutoff and feature version in manifest", () => {
    expect(chartManifest(candles, "Pair111", 300)).toMatchObject({
      timeframeSeconds: 300,
      barCutoff: 900,
      candleHash: expect.stringMatching(/^sha256:/u),
      imageHash: expect.stringMatching(/^sha256:/u),
    })
  })
})
