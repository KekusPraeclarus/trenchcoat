import { beforeEach, describe, expect, it, vi } from "vitest"
import type { MarketPair } from "../../src/collectors/market/providers.js"
import { searchDexScreener } from "../../src/collectors/market/providers.js"
import {
  fetchConversationLiveTape,
  formatLiveTapePromptLines,
  resolveConversationCa,
} from "../../src/discord/live-tape.js"

vi.mock("../../src/collectors/market/providers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/collectors/market/providers.js")>()
  return {
    ...actual,
    searchDexScreener: vi.fn(),
  }
})

vi.mock("../../src/lib/config.js", () => ({
  loadConfig: () => ({
    chat: {
      discord: {
        conversation: { max_research_per_turn: 5 },
      },
    },
  }),
}))

const RH_CA = "0xF8BC08092C06dB6148114DCf82AF881F1085f92b"
const OTHER_CA = "0x6055706234Dd0CC9965400296f2Ca950941f6253"

function pair(
  overrides: Partial<MarketPair> & Pick<MarketPair, "chainId" | "baseToken">,
): MarketPair {
  return {
    pairAddress: "Pair111111111111111111111111111111111111111",
    quoteToken: {
      address: "0x1111111111111111111111111111111111111111",
      symbol: "USDC",
      name: "USD Coin",
    },
    priceUsd: 0.01,
    liquidityUsd: 1_000,
    fdv: 50_000,
    priceChangeH24: -80,
    buys24h: 10,
    sells24h: 10,
    url: "https://dexscreener.com/robinhood/pair",
    ...overrides,
  }
}

describe("discord live tape", () => {
  beforeEach(() => {
    vi.mocked(searchDexScreener).mockReset()
  })

  it("resolveConversationCa returns validated robinhood CA subject", () => {
    const subject = resolveConversationCa(
      `what happened to robinhood:${RH_CA} after the dump?`,
    )
    expect(subject).toEqual({
      subject: `robinhood:${RH_CA}`,
      chainHint: "robinhood",
      tokenHint: RH_CA,
    })
  })

  it("resolveConversationCa returns undefined when two CAs appear", () => {
    expect(resolveConversationCa(
      `compare robinhood:${RH_CA} and robinhood:${OTHER_CA}`,
    )).toBeUndefined()
  })

  it("resolveConversationCa rejects invalid grammar", () => {
    expect(resolveConversationCa(
      "evilchain:0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    )).toBeUndefined()
    expect(resolveConversationCa("not a ca at all")).toBeUndefined()
  })

  it("fetchConversationLiveTape picks collect-observation pair (chain+address), not liquidity", async () => {
    vi.mocked(searchDexScreener).mockResolvedValue([
      pair({
        chainId: "base",
        baseToken: { address: RH_CA, symbol: "WRONG", name: "Wrong" },
        liquidityUsd: 9_999_999,
        fdv: 9_999_999,
      }),
      pair({
        chainId: "robinhood",
        baseToken: { address: RH_CA, symbol: "NUKED", name: "Nuked" },
        liquidityUsd: 500,
        fdv: 12_000,
        priceChangeH24: -92.5,
      }),
    ])

    const tape = await fetchConversationLiveTape({
      subject: {
        subject: `robinhood:${RH_CA}`,
        chainHint: "robinhood",
        tokenHint: RH_CA,
      },
    })

    expect(tape.status).toBe("ok")
    expect(tape.symbol).toBe("NUKED")
    expect(tape.fdvUsd).toBe(12_000)
    expect(tape.liquidityUsd).toBe(500)
    expect(tape.priceChangeH24).toBe(-92.5)
    expect(searchDexScreener).toHaveBeenCalledWith(
      expect.anything(),
      RH_CA.slice(0, 128),
    )
  })

  it("fetchConversationLiveTape returns failed on fetch error", async () => {
    vi.mocked(searchDexScreener).mockRejectedValue(new Error("gate down"))

    const tape = await fetchConversationLiveTape({
      subject: {
        subject: `robinhood:${RH_CA}`,
        chainHint: "robinhood",
        tokenHint: RH_CA,
      },
    })
    expect(tape).toMatchObject({
      status: "failed",
      chain: "robinhood",
      tokenAddress: RH_CA,
    })
    expect(tape.fdvUsd).toBeUndefined()
    expect(tape.liquidityUsd).toBeUndefined()
  })

  it("formatLiveTapePromptLines includes fdv, liquidity, priceChangeH24", () => {
    const lines = formatLiveTapePromptLines({
      status: "ok",
      chain: "robinhood",
      tokenAddress: RH_CA,
      symbol: "NUKED",
      priceUsd: 0.002,
      fdvUsd: 12_000,
      liquidityUsd: 500,
      priceChangeH24: -92.5,
      fetchedAt: "2026-08-12T10:00:00.000Z",
    })
    const joined = lines.join("\n")
    expect(joined).toContain("fdvUsd=12000")
    expect(joined).toContain("liquidityUsd=500")
    expect(joined).toContain("priceChangeH24=-92.5")
  })
})
