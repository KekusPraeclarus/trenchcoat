import { describe, expect, it } from "vitest"
import {
  collapseToBestPoolPerToken,
  resolveFromCandidates,
} from "../../src/lib/resolve.js"
import { normalizeEvmAddress } from "../../src/lib/address.js"

const SOL = "11111111111111111111111111111111"
const ETH_A = "0x5109A19e14766245320fAbC794b92F05f3cFa1B4"
const ETH_B = "0xf2A3CFDbE0f9Ab377B0cf8B38B589f3d74f3FF2e"
const BASE_A = "0xFf8104251E7761163faC3211eF5583FB3F8583d6"
const BASE_PAIR = "0xdf7470b0Fc66F216aD687416958C115e72AaD1fb"
const BASE_PAIR_2 = "0x2EF682177554f616fAE331796EBBFBf835E9Ed3B"

describe("resolveFromCandidates", () => {
  it("collapses multi-pool same token to the deepest pool and sums volume", () => {
    const collapsed = collapseToBestPoolPerToken([
      {
        chain: "ethereum",
        tokenAddress: ETH_A,
        pairAddress: ETH_B,
        symbolDisplay: "REPPO",
        liquidityUsd: 10_000,
        volume24hUsd: 1_000,
      },
      {
        chain: "ethereum",
        tokenAddress: ETH_A,
        pairAddress: "0x0000000000000000000000000000000000000001",
        symbolDisplay: "REPPO",
        liquidityUsd: 50_000,
        volume24hUsd: 500,
      },
    ])
    expect(collapsed).toHaveLength(1)
    expect(collapsed[0]?.liquidityUsd).toBe(50_000)
    expect(collapsed[0]?.volume24hUsd).toBe(1_500)
    expect(collapsed[0]?.pairAddress).toBe("0x0000000000000000000000000000000000000001")
  })

  it("skips synthetic DexScreener pair ids and still resolves", () => {
    const result = resolveFromCandidates([
      {
        chain: "base",
        tokenAddress: BASE_A,
        pairAddress: `${BASE_A}:bpool`,
        symbolDisplay: "REPPO",
        liquidityUsd: 900_000,
        volume24hUsd: 70_000,
      },
      {
        chain: "base",
        tokenAddress: BASE_A,
        pairAddress: BASE_PAIR,
        symbolDisplay: "REPPO",
        liquidityUsd: 280_000,
        volume24hUsd: 50_000,
      },
    ], { expectedSymbol: "REPPO" })
    expect(result.status).toBe("resolved")
    if (result.status !== "resolved") return
    expect(result.identity.pairAddress).toBe(normalizeEvmAddress(BASE_PAIR))
  })

  it("asks when active Base and idle high-liq ETH contracts are both plausible", () => {
    const result = resolveFromCandidates([
      {
        chain: "ethereum",
        tokenAddress: ETH_A,
        pairAddress: ETH_B,
        symbolDisplay: "REPPO",
        liquidityUsd: 1_900_000,
        volume24hUsd: 0.01,
      },
      {
        chain: "base",
        tokenAddress: BASE_A,
        pairAddress: BASE_PAIR,
        symbolDisplay: "REPPO",
        liquidityUsd: 280_000,
        volume24hUsd: 40_000,
      },
      {
        chain: "base",
        tokenAddress: BASE_A,
        pairAddress: BASE_PAIR_2,
        symbolDisplay: "REPPO",
        liquidityUsd: 70_000,
        volume24hUsd: 90_000,
      },
    ], { expectedSymbol: "REPPO" })
    expect(result.status).toBe("ambiguous")
    if (result.status !== "ambiguous") return
    expect(result.shortlist.map((item) => item.chain)).toContain("base")
    expect(result.shortlist.map((item) => item.chain)).toContain("ethereum")
  })

  it("asks when multiple exact-ticker CAs clear the credibility floor", () => {
    const result = resolveFromCandidates([
      {
        chain: "ethereum",
        tokenAddress: ETH_A,
        pairAddress: ETH_B,
        symbolDisplay: "REPPO",
        liquidityUsd: 80_000,
        volume24hUsd: 2_000,
      },
      {
        chain: "base",
        tokenAddress: BASE_A,
        pairAddress: BASE_PAIR,
        symbolDisplay: "REPPO",
        liquidityUsd: 70_000,
        volume24hUsd: 200_000,
      },
    ], { expectedSymbol: "REPPO" })
    expect(result.status).toBe("ambiguous")
    if (result.status !== "ambiguous") return
    expect(result.shortlist).toHaveLength(2)
  })

  it("stays ambiguous when same-symbol CAs are within 5× credibility", () => {
    const result = resolveFromCandidates([
      {
        chain: "ethereum",
        tokenAddress: ETH_A,
        pairAddress: ETH_B,
        symbolDisplay: "REPPO",
        liquidityUsd: 100_000,
        volume24hUsd: 10_000,
      },
      {
        chain: "base",
        tokenAddress: BASE_A,
        pairAddress: BASE_PAIR,
        symbolDisplay: "REPPO",
        liquidityUsd: 40_000,
        volume24hUsd: 8_000,
      },
    ], { expectedSymbol: "REPPO" })
    expect(result.status).toBe("ambiguous")
    if (result.status !== "ambiguous") return
    expect(result.shortlist.map((s) => s.chain).sort()).toEqual(["base", "ethereum"])
  })

  it("prefers exact symbol matches over name collisions", () => {
    const result = resolveFromCandidates([
      {
        chain: "solana",
        tokenAddress: SOL,
        pairAddress: SOL,
        symbolDisplay: "REPPOAI",
        liquidityUsd: 1_000_000,
        volume24hUsd: 500_000,
      },
      {
        chain: "base",
        tokenAddress: BASE_A,
        pairAddress: BASE_PAIR,
        symbolDisplay: "REPPO",
        liquidityUsd: 50_000,
        volume24hUsd: 20_000,
      },
    ], { expectedSymbol: "REPPO" })
    expect(result.status).toBe("resolved")
    if (result.status !== "resolved") return
    expect(result.identity.symbolDisplay).toBe("REPPO")
    expect(result.identity.chain).toBe("base")
  })
})
