import { describe, expect, it } from "vitest"
import {
  extractNarrativeTickers,
  normalizeSymbol,
  STOPWORDS,
} from "../../src/lib/narrative-tickers.js"

const NOW = "2026-07-18T12:00:00.000Z"

describe("narrative tickers", () => {
  it("normalizes valid symbols and rejects malformed or stopword symbols", () => {
    expect(normalizeSymbol(" $Jimothy ")).toBe("Jimothy")
    expect(normalizeSymbol("A")).toBeUndefined()
    expect(normalizeSymbol("BAD TICKER")).toBeUndefined()
    expect(normalizeSymbol("THE")).toBeUndefined()
    expect(STOPWORDS.has("THE")).toBe(true)
  })

  it("prioritizes explicit tickers and caps extraction deterministically", () => {
    const tickers = extractNarrativeTickers({
      slug: "unrelated",
      title: "$ONE $TWO $THREE $FOUR $FIVE $SIX $SEVEN $EIGHT $NINE",
      firstSeen: NOW,
      lastSeen: NOW,
      evidence: [],
      stage: "emerging",
      tickers: ["Jimothy", "BAD TICKER", "jimothy"],
    })

    expect(tickers).toHaveLength(8)
    expect(tickers[0]).toBe("Jimothy")
    expect(tickers).not.toContain("BAD TICKER")
  })
})
