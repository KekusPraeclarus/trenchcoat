import { describe, expect, it } from "vitest"
import {
  extractNarrativeTickers,
  isGenericChainSymbol,
  normalizeSymbol,
  STOPWORDS,
  GENERIC_CHAIN_SYMBOLS,
} from "../../src/lib/narrative-tickers.js"

const NOW = "2026-07-18T12:00:00.000Z"

describe("narrative tickers", () => {
  it("normalizes valid symbols and rejects malformed, stopword, or generic symbols", () => {
    expect(normalizeSymbol(" $Jimothy ")).toBe("Jimothy")
    expect(normalizeSymbol("A")).toBeUndefined()
    expect(normalizeSymbol("BAD TICKER")).toBeUndefined()
    expect(normalizeSymbol("THE")).toBeUndefined()
    expect(normalizeSymbol("SOL")).toBeUndefined()
    expect(normalizeSymbol("$USDC")).toBeUndefined()
    expect(normalizeSymbol("WETH")).toBeUndefined()
    expect(STOPWORDS.has("THE")).toBe(true)
    expect(GENERIC_CHAIN_SYMBOLS.has("SOL")).toBe(true)
    expect(isGenericChainSymbol("sol")).toBe(true)
  })

  it("accepts only explicit ticker fields and cashtags — never bare uppercase words", () => {
    const fromBare = extractNarrativeTickers({
      slug: "sol-season",
      title: "SOL season MEME rotation ETH",
      firstSeen: NOW,
      lastSeen: NOW,
      evidence: [],
      stage: "emerging",
    })
    expect(fromBare).toEqual([])

    const fromCashtag = extractNarrativeTickers({
      slug: "jimothy-season",
      title: "$JIMOTHY season with SOL noise",
      firstSeen: NOW,
      lastSeen: NOW,
      evidence: [],
      stage: "emerging",
    })
    expect(fromCashtag).toEqual(["JIMOTHY"])
  })

  it("prioritizes explicit tickers and caps extraction deterministically", () => {
    const tickers = extractNarrativeTickers({
      slug: "unrelated",
      title: "$ONE $TWO $THREE $FOUR $FIVE $SIX $SEVEN $EIGHT $NINE",
      firstSeen: NOW,
      lastSeen: NOW,
      evidence: [],
      stage: "emerging",
      tickers: ["Jimothy", "BAD TICKER", "jimothy", "SOL"],
    })

    expect(tickers).toHaveLength(8)
    expect(tickers[0]).toBe("Jimothy")
    expect(tickers).not.toContain("BAD TICKER")
    expect(tickers).not.toContain("SOL")
  })
})
