import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { computeEmaStructure, computeLiquidityDelta, computeRangeBreakout, computeVolumeZScore, FEATURE_SPEC_VERSION, pairMigrationDiscontinuity } from "../../src/collectors/market/indicators.js"
import { parseDexScreenerPairs } from "../../src/collectors/market/providers.js"
import { mapGoPlus, mapRugCheck, preflightMarketQuality } from "../../src/collectors/market/security.js"
import type { OhlcvCandle } from "../../src/collectors/market/geckoterminal.js"

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(process.cwd(), "tests/fixtures/providers", name), "utf8")) as unknown
const candles = (count: number): OhlcvCandle[] => Array.from({ length: count }, (_, index) => ({
  startTime: index * 3_600,
  open: index + 1,
  high: index + 2,
  low: index,
  close: index + 1,
  volume: index + 10,
}))

describe("market collectors", () => {
  it("parses DexScreener pairs without treating it as OHLCV", () => {
    const pair = parseDexScreenerPairs(fixture("dex-pair.json"))[0]!
    expect(pair.liquidityUsd).toBe(50_000)
    expect(pair.buys24h + pair.sells24h).toBe(200)
  })

  it("reads priceChange.h24 into priceChangeH24 when present", () => {
    const base = (fixture("dex-pair.json") as { pairs: object[] }).pairs[0]!
    const pair = parseDexScreenerPairs({
      pairs: [{ ...base, priceChange: { h24: -42.5, h6: -10 } }],
    })[0]!
    expect(pair.priceChangeH24).toBe(-42.5)
  })

  it("skips DexScreener pairs with overlong or missing token fields", () => {
    const good = (fixture("dex-pair.json") as { pairs: unknown[] }).pairs[0]!
    const pairs = parseDexScreenerPairs({
      pairs: [
        {
          ...good as object,
          baseToken: {
            address: "Token11111111111111111111111111111111111111",
            symbol: "x".repeat(513),
            name: "Bad",
          },
        },
        good,
        { chainId: "solana" },
      ],
    })
    expect(pairs).toHaveLength(1)
    expect(pairs[0]?.baseToken.symbol).toBe("TEST")
  })

  it("version-tags deterministic indicator helpers", () => {
    expect(computeVolumeZScore(candles(192), 3_600).featureSpecVersion).toBe(FEATURE_SPEC_VERSION)
    expect(computeEmaStructure(candles(50), 3_600).value?.structure).toBe("bullish")
    expect(computeRangeBreakout([...candles(169), { ...candles(169).at(-1)!, startTime: 169 * 3_600, close: 999 }], 3_600).value).toBe("up")
    expect(computeLiquidityDelta(100, 70).value).toBeCloseTo(-0.3)
    expect(pairMigrationDiscontinuity("old", "new")).toMatchObject({ valid: false, reason: "pair-migration" })
  })

  it("maps hard security flags and keeps cautions non-blocking", () => {
    expect(mapGoPlus({ result: { is_honeypot: "1" } }).status).toBe("hard-fail")
    expect(mapGoPlus({ result: { buy_tax: "0.10", is_open_source: "1" } })).toMatchObject({ status: "pass", flags: ["buy-tax"] })
    expect(mapGoPlus({ result: { is_mintable: "1", is_open_source: "1" } })).toMatchObject({
      status: "pass",
      hardFail: false,
      flags: ["mintable"],
    })
    expect(mapRugCheck({ mintAuthority: "authority" })).toMatchObject({
      status: "pass",
      hardFail: false,
      flags: ["mint-authority"],
    })
    expect(mapRugCheck({ freezeAuthority: "authority" }).status).toBe("hard-fail")
  })

  it("fails market quality for one-sided or thin pairs", () => {
    const pair = parseDexScreenerPairs(fixture("dex-pair.json"))[0]!
    expect(preflightMarketQuality(pair, 100_000).status).toBe("fail")
    expect(preflightMarketQuality({ ...pair, liquidityUsd: 100_000, fdv: 1_000_000 }, 100_000).status).toBe("pass")
  })
})
