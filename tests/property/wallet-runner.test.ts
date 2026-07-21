import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { sha256Json } from "../../src/lib/canonical-json.js"
import { deriveWalletBuyConvergence } from "../../src/wallets/convergence.js"
import {
  antiAutomationRejectReason,
  capNewCandidates,
  qualifyRunnerPool,
  rankEarlyRunnerBuyers,
  walletsMeetingRecurrence,
} from "../../src/wallets/runner-discovery.js"
import {
  classifyEvmBytecode,
  classifyHardExclusion,
  classifySolanaAccount,
  sameSlotBuyRatio,
} from "../../src/wallets/exclusions.js"
import type { WalletBuyOutcome } from "../../src/contracts/schemas.js"

const TOKEN = "Token1111111111111111111111111111111111111"
const NOW = "2026-07-21T18:00:00.000Z"

describe("prop_inv_s29 runner discovery and convergence", () => {
  it("caps always hold under arbitrary sighting lists", () => {
    fc.assert(fc.property(
      fc.array(fc.record({
        chain: fc.constantFrom("solana", "ethereum", "base", "robinhood"),
        address: fc.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/u),
        origin: fc.constant("new-pools" as const),
      }), { maxLength: 300 }),
      fc.integer({ min: 0, max: 100 }),
      (sightings, max) => {
        const capped = capNewCandidates(sightings, max)
        expect(capped.length).toBeLessThanOrEqual(max)
      },
    ))
  })

  it("provider reorder yields identical ranked buyers", () => {
    fc.assert(fc.property(
      fc.array(fc.record({
        walletAddress: fc.constantFrom("w1", "w2", "w3", "w4", "w5"),
        offsetMin: fc.integer({ min: 0, max: 40 }),
        eventN: fc.integer({ min: 1, max: 99 }),
      }), { minLength: 1, maxLength: 20 }),
      (rows) => {
        const events = rows.map((r) => ({
          chain: "solana",
          tokenAddress: TOKEN,
          walletAddress: r.walletAddress,
          boughtAtIso: new Date(Date.parse("2026-07-21T12:00:00.000Z") + r.offsetMin * 60_000)
            .toISOString(),
          providerEventId: `e${r.eventN}`,
          runnerId: "r1",
        }))
        const shuffled = [...events].sort(() => 0.5 - Math.random())
        const a = rankEarlyRunnerBuyers(events, {
          runnerId: "r1",
          firstSeenAt: "2026-07-21T12:00:00.000Z",
          windowMinutes: 30,
          topN: 25,
        })
        const b = rankEarlyRunnerBuyers(shuffled, {
          runnerId: "r1",
          firstSeenAt: "2026-07-21T12:00:00.000Z",
          windowMinutes: 30,
          topN: 25,
        })
        expect(a?.buyers).toEqual(b?.buyers)
      },
    ))
  })

  it("four duplicate events from one wallet never converge", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 20 }), (n) => {
      const outcomes: WalletBuyOutcome[] = Array.from({ length: n }, (_, i) => ({
        schema: 1 as const,
        eventId: `wb_${i}`,
        walletId: "solana:only",
        chain: "solana" as const,
        tokenAddress: TOKEN,
        boughtAt: new Date(Date.parse("2026-07-21T17:00:00.000Z") + i * 60_000).toISOString(),
        finalized: true,
        removed: false,
        priceable: true,
        rug: false,
        walletStatusAtEvent: "tracking" as const,
      }))
      expect(deriveWalletBuyConvergence(outcomes, {
        minWallets: 4,
        windowMinutes: 15,
        maxTokenAgeHours: 24,
        nowIso: NOW,
        hash: (p) => sha256Json(p as never),
      })).toHaveLength(0)
    }))
  })

  it("no cross-chain merge for convergence", () => {
    const base = (walletId: string, chain: "solana" | "ethereum", at: string): WalletBuyOutcome => ({
      schema: 1,
      eventId: `wb_${walletId}_${chain}`,
      walletId,
      chain,
      tokenAddress: TOKEN,
      boughtAt: at,
      finalized: true,
      removed: false,
      priceable: true,
      rug: false,
      walletStatusAtEvent: "tracking",
    })
    const signals = deriveWalletBuyConvergence([
      base("w1", "solana", "2026-07-21T17:00:00.000Z"),
      base("w2", "solana", "2026-07-21T17:01:00.000Z"),
      base("w3", "ethereum", "2026-07-21T17:02:00.000Z"),
      base("w4", "ethereum", "2026-07-21T17:03:00.000Z"),
    ], {
      minWallets: 4,
      windowMinutes: 15,
      maxTokenAgeHours: 24,
      nowIso: NOW,
      hash: (p) => sha256Json(p as never),
    })
    expect(signals).toHaveLength(0)
  })

  it("only event-time tracking wallets count", () => {
    const mk = (id: string, status: "tracking" | "candidate"): WalletBuyOutcome => ({
      schema: 1,
      eventId: id,
      walletId: id,
      chain: "solana",
      tokenAddress: TOKEN,
      boughtAt: "2026-07-21T17:00:00.000Z",
      finalized: true,
      removed: false,
      priceable: true,
      rug: false,
      walletStatusAtEvent: status,
    })
    expect(deriveWalletBuyConvergence([
      mk("t1", "tracking"),
      mk("t2", "tracking"),
      mk("t3", "tracking"),
      mk("c4", "candidate"),
    ], {
      minWallets: 4,
      windowMinutes: 15,
      maxTokenAgeHours: 24,
      nowIso: NOW,
      hash: (p) => sha256Json(p as never),
    })).toHaveLength(0)
  })

  it("unknown qualification metrics fail closed", () => {
    expect(qualifyRunnerPool({
      runnerId: "r",
      chain: "solana",
      poolAddress: "11111111111111111111111111111111",
      tokenAddress: TOKEN,
      pairAddress: "11111111111111111111111111111111",
      firstSeenAt: "2026-07-21T12:00:00.000Z",
    }, NOW, {
      maxAgeHours: 24,
      minLiquidityUsd: 50_000,
      minReturn6h: 1,
      minVolume6hUsd: 250_000,
    })).toBe("liquidity-unknown")
  })

  it("recurrence requires distinct runners", () => {
    expect(walletsMeetingRecurrence([
      { walletKey: "solana:a", runnerIds: ["r1", "r1"], lastSeenIso: NOW },
    ], { minRunners: 2, lookbackDays: 30, nowIso: NOW })).toEqual([])
  })

  it("bytecode and executable classifiers are deterministic", () => {
    expect(classifyEvmBytecode("0x")).toBe("eoa")
    expect(classifyEvmBytecode("0x608060")).toBe("contract")
    expect(classifyEvmBytecode(null)).toBe("unknown")
    expect(classifySolanaAccount({ executable: true })).toBe("program")
    expect(classifySolanaAccount({ executable: false })).toBe("wallet")
    expect(classifyHardExclusion({ address: "x", kind: "pool" })).toBe("pool")
    expect(sameSlotBuyRatio([1, 1, 1, 2]).ratio).toBeCloseTo(0.75)
    expect(antiAutomationRejectReason({
      buysLastHour: 1,
      distinctTokensLastDay: 1,
      sameSlotBuyRatio: 0.6,
      sameSlotBuySample: 20,
    }, {
      maxBuysPerHour: 20,
      maxDistinctTokensPerDay: 30,
      sameSlotRatio: 0.5,
      sameSlotMinBuys: 20,
      sameFunderClusterMax: 4,
    })).toBe("same-slot-cluster")
  })
})
