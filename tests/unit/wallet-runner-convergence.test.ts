import { describe, expect, it } from "vitest"
import { deriveWalletBuyConvergence } from "../../src/wallets/convergence.js"
import {
  antiAutomationRejectReason,
  capNewCandidates,
  qualifyRunnerPool,
  rankEarlyRunnerBuyers,
  walletsMeetingRecurrence,
} from "../../src/wallets/runner-discovery.js"
import { reconcileInvalidFomoWallets } from "../../src/wallets/fomo-reconcile.js"
import { eligibleWalletActions } from "../../src/wallets/providers.js"
import { extractSolanaVerifiedBuysFromTransaction } from "../../src/collectors/wallets/helius-provider.js"
import { sha256Json } from "../../src/lib/canonical-json.js"
import {
  classifyHardExclusion,
  exclusionSubjectsFromEvidence,
  upsertWalletExclusion,
} from "../../src/wallets/exclusions.js"
import type { WalletBuyOutcome, WalletsFile } from "../../src/contracts/schemas.js"

const SOL = "11111111111111111111111111111111"
const TOKEN = "Token1111111111111111111111111111111111111"
const NOW = "2026-07-21T18:00:00.000Z"

describe("verified solana buy extraction", () => {
  it("requires target gain plus native/quote spend by signer", () => {
    const buyer = "Buyer111111111111111111111111111111111111111"
    const buys = extractSolanaVerifiedBuysFromTransaction({
      slot: 10,
      blockTime: 1_700_000_000,
      meta: {
        err: null,
        preBalances: [1_000_000_000],
        postBalances: [900_000_000],
        preTokenBalances: [],
        postTokenBalances: [{
          mint: TOKEN,
          owner: buyer,
          uiTokenAmount: { amount: "1000" },
        }],
      },
      transaction: {
        signatures: ["sig1"],
        message: { accountKeys: [buyer] },
      },
    }, TOKEN, { acceptNative: true, allowlist: [] })
    expect(buys).toHaveLength(1)
    expect(buys[0]?.classification).toBe("swap-buy")
    expect(buys[0]?.quoteSpent?.asset).toBe("native")
  })

  it("rejects airdrop-style balance increases without quote spend", () => {
    const buyer = "Buyer111111111111111111111111111111111111111"
    const buys = extractSolanaVerifiedBuysFromTransaction({
      slot: 10,
      blockTime: 1_700_000_000,
      meta: {
        err: null,
        preBalances: [1_000_000_000],
        postBalances: [1_000_000_000],
        preTokenBalances: [],
        postTokenBalances: [{
          mint: TOKEN,
          owner: buyer,
          uiTokenAmount: { amount: "1000" },
        }],
      },
      transaction: {
        signatures: ["sig1"],
        message: { accountKeys: [buyer] },
      },
    }, TOKEN, { acceptNative: true, allowlist: [] })
    expect(buys).toHaveLength(0)
  })
})

describe("eligibleWalletActions", () => {
  it("keeps only finalized swap-buys", () => {
    expect(eligibleWalletActions([
      {
        walletAddress: SOL,
        tokenAddress: TOKEN,
        timestamp: 1,
        finalized: true,
        priceable: true,
        providerEventId: "a",
        blockOrSlot: 1,
        classification: "swap-buy",
      },
      {
        walletAddress: SOL,
        tokenAddress: TOKEN,
        timestamp: 1,
        finalized: true,
        priceable: true,
        providerEventId: "b",
        blockOrSlot: 1,
        classification: "unknown",
      },
    ])).toHaveLength(1)
  })
})

describe("runner qualification and ranking", () => {
  it("qualifies only when liquidity/return/volume/age known and pass", () => {
    expect(qualifyRunnerPool({
      runnerId: "r1",
      chain: "solana",
      poolAddress: SOL,
      tokenAddress: TOKEN,
      pairAddress: SOL,
      firstSeenAt: "2026-07-21T12:00:00.000Z",
      liquidityUsd: 60_000,
      return6h: 1.2,
      volume6hUsd: 300_000,
    }, NOW, {
      maxAgeHours: 24,
      minLiquidityUsd: 50_000,
      minReturn6h: 1,
      minVolume6hUsd: 250_000,
    })).toBeUndefined()

    expect(qualifyRunnerPool({
      runnerId: "r1",
      chain: "solana",
      poolAddress: SOL,
      tokenAddress: TOKEN,
      pairAddress: SOL,
      firstSeenAt: "2026-07-21T12:00:00.000Z",
      liquidityUsd: 10_000,
      return6h: 1.2,
      volume6hUsd: 300_000,
    }, NOW, {
      maxAgeHours: 24,
      minLiquidityUsd: 50_000,
      minReturn6h: 1,
      minVolume6hUsd: 250_000,
    })).toBe("liquidity-low")
  })

  it("ranks earliest unique buyers inside the window", () => {
    const ranked = rankEarlyRunnerBuyers([
      {
        chain: "solana",
        tokenAddress: TOKEN,
        walletAddress: "w2",
        boughtAtIso: "2026-07-21T12:10:00.000Z",
        providerEventId: "2",
        runnerId: "r1",
      },
      {
        chain: "solana",
        tokenAddress: TOKEN,
        walletAddress: "w1",
        boughtAtIso: "2026-07-21T12:01:00.000Z",
        providerEventId: "1",
        runnerId: "r1",
      },
      {
        chain: "solana",
        tokenAddress: TOKEN,
        walletAddress: "w3",
        boughtAtIso: "2026-07-21T13:00:00.000Z",
        providerEventId: "3",
        runnerId: "r1",
      },
    ], {
      runnerId: "r1",
      firstSeenAt: "2026-07-21T12:00:00.000Z",
      windowMinutes: 30,
      topN: 25,
    })
    expect(ranked?.buyers).toEqual(["w1", "w2"])
  })

  it("requires multi-runner recurrence", () => {
    expect(walletsMeetingRecurrence([
      { walletKey: "solana:w1", runnerIds: ["r1", "r2"], lastSeenIso: NOW },
      { walletKey: "solana:w2", runnerIds: ["r1"], lastSeenIso: NOW },
    ], { minRunners: 2, lookbackDays: 30, nowIso: NOW })).toEqual(["solana:w1"])
  })

  it("caps new candidates per run", () => {
    expect(capNewCandidates([
      { chain: "solana", address: "a", origin: "new-pools" },
      { chain: "solana", address: "b", origin: "new-pools" },
      { chain: "solana", address: "c", origin: "new-pools" },
    ], 2)).toHaveLength(2)
  })

  it("rejects automation heuristics when evidence complete", () => {
    expect(antiAutomationRejectReason({
      buysLastHour: 21,
      distinctTokensLastDay: 5,
    }, {
      maxBuysPerHour: 20,
      maxDistinctTokensPerDay: 30,
      sameSlotRatio: 0.5,
      sameSlotMinBuys: 20,
      sameFunderClusterMax: 4,
    })).toBe("buys-per-hour")
  })
})

describe("fomo wallet reconciliation", () => {
  it("excludes candidates and drops tracking fomo wallets", () => {
    const file: WalletsFile = {
      schema: 1,
      wallets: [
        {
          schema: 1,
          walletId: `solana:${SOL}`,
          chain: "solana",
          address: SOL,
          status: "candidate",
          discoveredFrom: "fomo",
          addedAt: NOW,
          updatedAt: NOW,
          hardExcluded: false,
        },
        {
          schema: 1,
          walletId: "solana:Tracking1111111111111111111111111111111",
          chain: "solana",
          address: "Tracking1111111111111111111111111111111",
          status: "tracking",
          discoveredFrom: "fomo",
          addedAt: NOW,
          updatedAt: NOW,
          hardExcluded: false,
        },
      ],
      transitions: [],
      pendingTransitionIds: [],
      cursors: [],
      exclusions: [],
    }
    const result = reconcileInvalidFomoWallets(file, NOW)
    expect(result.file.wallets.find((w) => w.status === "excluded")?.hardExclusionReason)
      .toBe("invalid-fomo-profile-address")
    expect(result.file.wallets.find((w) => w.status === "dropped")?.hardExclusionReason)
      .toBe("invalid-fomo-profile-address")
    expect(result.transitions).toHaveLength(1)
  })
})

describe("wallet buy convergence", () => {
  function outcome(
    walletId: string,
    boughtAt: string,
    status: "tracking" | "candidate" = "tracking",
  ): WalletBuyOutcome {
    return {
      schema: 1,
      eventId: `wb_${walletId}_${boughtAt}`,
      walletId,
      chain: "solana",
      tokenAddress: TOKEN,
      boughtAt,
      finalized: true,
      removed: false,
      priceable: true,
      rug: false,
      walletStatusAtEvent: status,
    }
  }

  it("fires when 4 unique tracking wallets buy within the window", () => {
    const signals = deriveWalletBuyConvergence([
      outcome("w1", "2026-07-21T17:00:00.000Z"),
      outcome("w2", "2026-07-21T17:02:00.000Z"),
      outcome("w3", "2026-07-21T17:04:00.000Z"),
      outcome("w4", "2026-07-21T17:06:00.000Z"),
      outcome("cand", "2026-07-21T17:01:00.000Z", "candidate"),
    ], {
      minWallets: 4,
      windowMinutes: 15,
      maxTokenAgeHours: 24,
      nowIso: NOW,
      hash: (p) => sha256Json(p as never),
    })
    expect(signals).toHaveLength(1)
    expect(signals[0]?.walletIds).toEqual(["w1", "w2", "w3", "w4"])
  })

  it("does not count four events from one wallet", () => {
    const signals = deriveWalletBuyConvergence([
      outcome("w1", "2026-07-21T17:00:00.000Z"),
      outcome("w1", "2026-07-21T17:01:00.000Z"),
      outcome("w1", "2026-07-21T17:02:00.000Z"),
      outcome("w1", "2026-07-21T17:03:00.000Z"),
    ], {
      minWallets: 4,
      windowMinutes: 15,
      maxTokenAgeHours: 24,
      nowIso: NOW,
      hash: (p) => sha256Json(p as never),
    })
    expect(signals).toHaveLength(0)
  })
})

describe("hard exclusion evidence", () => {
  it("persists and classifies contract/program/pool kinds", () => {
    let file: WalletsFile = {
      schema: 1,
      wallets: [],
      transitions: [],
      pendingTransitionIds: [],
      cursors: [],
      exclusions: [],
    }
    file = upsertWalletExclusion(file, {
      chain: "ethereum",
      address: "0x1111111111111111111111111111111111111111",
      kind: "contract",
      observedAt: NOW,
    })
    file = upsertWalletExclusion(file, {
      chain: "solana",
      address: SOL,
      kind: "program",
      observedAt: NOW,
    })
    const subjects = exclusionSubjectsFromEvidence(file.exclusions ?? [])
    expect(classifyHardExclusion(subjects.get("ethereum:0x1111111111111111111111111111111111111111")!))
      .toBe("contract")
    expect(classifyHardExclusion(subjects.get(`solana:${SOL}`)!)).toBe("program")
  })
})
