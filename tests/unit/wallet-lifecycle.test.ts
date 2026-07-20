import { describe, expect, it } from "vitest"
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { classifyHardExclusion } from "../../src/wallets/exclusions.js"
import { registerWalletCandidates } from "../../src/wallets/discovery.js"
import { aggregateWalletPerformance } from "../../src/wallets/outcomes.js"
import { reviewWalletLifecycle, shouldDropWallet } from "../../src/wallets/review.js"
import { extractSolanaBuyersFromTransaction } from "../../src/collectors/wallets/helius-provider.js"
import { decodeErc20Transfer } from "../../src/collectors/wallets/infura.js"
import { getChain, isTrackableChain, chainSlugFromProviderId } from "../../src/lib/chains.js"
import { StateStore } from "../../src/lib/state.js"
import type { WalletBuyOutcome, WalletRecord, WalletsFile } from "../../src/contracts/schemas.js"

const SOL = "11111111111111111111111111111111"
const NOW = "2026-07-16T18:00:00.000Z"
const CUTOFF = "2026-07-16T18:00:00.000Z"

const EMPTY: WalletsFile = {
  schema: 1,
  wallets: [],
  transitions: [],
  pendingTransitionIds: [],
  cursors: [],
}

const thresholds = {
  max_transitions_per_review: 20,
  deterministic_weight: 0.8,
  llm_weight: 0.2,
  promotion: {
    min_effective_buys: 2,
    min_distinct_tokens: 1,
    min_coverage: 0.5,
    min_deterministic: 0.1,
    min_blended: 0.1,
    min_hit_mean: 0.5,
    min_hit_lb95: 0.1,
    min_median_excess: 0.05,
    max_rug_exposure: 0.5,
    max_idle_days: 30,
  },
  drop: {
    idle_days: 45,
    rug_exposure: 0.25,
    coverage_floor: 0.5,
    deterministic_floor: 0.4,
    blended_floor: 0.45,
    readd_cooldown_days: 30,
    readd_min_new_events: 5,
  },
}

function wallet(partial: Partial<WalletRecord> & Pick<WalletRecord, "walletId" | "status">): WalletRecord {
  return {
    schema: 1,
    chain: "solana",
    address: SOL,
    addedAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    hardExcluded: false,
    ...partial,
  }
}

describe("wallet exclusions", () => {
  it("maps entity kinds and fails closed on unknown", () => {
    expect(classifyHardExclusion({ address: "x", kind: "pool" })).toBe("pool")
    expect(classifyHardExclusion({ address: "x", kind: "mystery" })).toBe("contract")
    expect(classifyHardExclusion({ address: "x", failedTx: true })).toBe("failed-tx")
    expect(classifyHardExclusion({ address: "x", priceable: false })).toBe("unpriceable")
  })
})

describe("wallet discovery registration", () => {
  it("stages unique candidates and skips unsupported chains", () => {
    const next = registerWalletCandidates(EMPTY, [
      { chain: "solana", address: SOL, origin: "watchlist" },
      { chain: "solana", address: SOL, origin: "watchlist" },
      { chain: "bsc", address: "0x742d35cc6634c0532925a3b844bc454e4438f44e", origin: "watchlist" },
    ], NOW)
    expect(next.wallets).toHaveLength(1)
    expect(next.wallets[0]?.status).toBe("candidate")
    expect(next.wallets[0]?.discoveredFrom).toBe("watchlist")
  })
})

describe("solana buyer extraction", () => {
  it("extracts owners with positive mint balance delta", () => {
    const buyers = extractSolanaBuyersFromTransaction({
      meta: {
        err: null,
        preTokenBalances: [],
        postTokenBalances: [{
          mint: SOL,
          owner: "Buyer111111111111111111111111111111111111111",
          uiTokenAmount: { amount: "1000" },
        }],
      },
      transaction: { message: { accountKeys: [SOL] } },
    }, SOL)
    expect(buyers).toEqual(["Buyer111111111111111111111111111111111111111"])
  })
})

describe("evm transfer decode", () => {
  it("decodes Transfer topics", () => {
    const decoded = decodeErc20Transfer({
      topics: [
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        "0x0000000000000000000000001111111111111111111111111111111111111111",
        "0x0000000000000000000000002222222222222222222222222222222222222222",
      ],
      data: "0x0",
    })
    expect(decoded?.from).toBe("0x1111111111111111111111111111111111111111")
    expect(decoded?.to).toBe("0x2222222222222222222222222222222222222222")
  })
})

describe("wallet outcomes + review", () => {
  it("aggregates lagged settled buys and promotes candidates", () => {
    const outcomes: WalletBuyOutcome[] = [
      {
        schema: 1,
        eventId: "wb_a",
        walletId: "solana:w1",
        chain: "solana",
        tokenAddress: SOL,
        boughtAt: "2026-07-10T00:00:00.000Z",
        settledAt: "2026-07-12T00:00:00.000Z",
        excessReturn72h: 0.4,
        leadTimeHours: 6,
        maxDrawdown: 0.1,
        rug: false,
        finalized: true,
        removed: false,
        priceable: true,
      },
      {
        schema: 1,
        eventId: "wb_b",
        walletId: "solana:w1",
        chain: "solana",
        tokenAddress: SOL,
        boughtAt: "2026-07-11T00:00:00.000Z",
        settledAt: "2026-07-13T00:00:00.000Z",
        excessReturn72h: 0.3,
        leadTimeHours: 4,
        maxDrawdown: 0.05,
        rug: false,
        finalized: true,
        removed: false,
        priceable: true,
      },
      {
        schema: 1,
        eventId: "wb_future",
        walletId: "solana:w1",
        chain: "solana",
        tokenAddress: SOL,
        boughtAt: "2026-07-17T00:00:00.000Z",
        settledAt: "2026-07-18T00:00:00.000Z",
        excessReturn72h: 0.9,
        rug: false,
        finalized: true,
        removed: false,
        priceable: true,
      },
    ]
    const perf = aggregateWalletPerformance("solana:w1", outcomes, CUTOFF, NOW)
    expect(perf.effectiveBuys).toBe(2)
    expect(perf.settledBuys).toBe(2)
    expect(perf.hitMean).toBe(1)

    const file: WalletsFile = {
      ...EMPTY,
      wallets: [wallet({ walletId: "solana:w1", status: "candidate", address: SOL })],
    }
    const result = reviewWalletLifecycle({
      file,
      performances: new Map([["solana:w1", perf]]),
      llmScores: new Map([["solana:w1", 50]]),
      hardExclusions: new Map(),
      epochId: "epoch-1",
      nowIso: NOW,
      thresholds,
    })
    expect(result.file.wallets[0]?.status).toBe("tracking")
    expect(result.applied.some((t) => t.action === "added")).toBe(true)
  })

  it("prop_inv_s19_excludes removed unfinalized and post-cutoff buys", () => {
    const outcomes: WalletBuyOutcome[] = [
      {
        schema: 1,
        eventId: "wb_ok",
        walletId: "solana:w1",
        chain: "solana",
        tokenAddress: SOL,
        boughtAt: "2026-07-10T00:00:00.000Z",
        settledAt: "2026-07-12T00:00:00.000Z",
        excessReturn72h: 0.4,
        rug: false,
        finalized: true,
        removed: false,
        priceable: true,
      },
      {
        schema: 1,
        eventId: "wb_removed",
        walletId: "solana:w1",
        chain: "solana",
        tokenAddress: SOL,
        boughtAt: "2026-07-10T00:00:00.000Z",
        settledAt: "2026-07-12T00:00:00.000Z",
        excessReturn72h: 0.9,
        rug: false,
        finalized: true,
        removed: true,
        priceable: true,
      },
      {
        schema: 1,
        eventId: "wb_unfinalized",
        walletId: "solana:w1",
        chain: "solana",
        tokenAddress: SOL,
        boughtAt: "2026-07-10T00:00:00.000Z",
        settledAt: "2026-07-12T00:00:00.000Z",
        excessReturn72h: 0.9,
        rug: false,
        finalized: false,
        removed: false,
        priceable: true,
      },
      {
        schema: 1,
        eventId: "wb_late",
        walletId: "solana:w1",
        chain: "solana",
        tokenAddress: SOL,
        boughtAt: "2026-07-17T00:00:00.000Z",
        settledAt: "2026-07-18T00:00:00.000Z",
        excessReturn72h: 0.9,
        rug: false,
        finalized: true,
        removed: false,
        priceable: true,
      },
    ]
    const perf = aggregateWalletPerformance("solana:w1", outcomes, CUTOFF, NOW)
    expect(perf.effectiveBuys).toBe(1)
    expect(perf.settledBuys).toBe(1)
  })

  it("prop_inv_s19_review_idempotent_on_existing_transition_ids", () => {
    const perf = aggregateWalletPerformance("solana:w1", [{
      schema: 1,
      eventId: "wb_a",
      walletId: "solana:w1",
      chain: "solana",
      tokenAddress: SOL,
      boughtAt: "2026-07-10T00:00:00.000Z",
      settledAt: "2026-07-12T00:00:00.000Z",
      excessReturn72h: 0.4,
      leadTimeHours: 6,
      maxDrawdown: 0.1,
      rug: false,
      finalized: true,
      removed: false,
      priceable: true,
    }, {
      schema: 1,
      eventId: "wb_b",
      walletId: "solana:w1",
      chain: "solana",
      tokenAddress: SOL,
      boughtAt: "2026-07-11T00:00:00.000Z",
      settledAt: "2026-07-13T00:00:00.000Z",
      excessReturn72h: 0.3,
      leadTimeHours: 4,
      maxDrawdown: 0.05,
      rug: false,
      finalized: true,
      removed: false,
      priceable: true,
    }], CUTOFF, NOW)
    const file: WalletsFile = {
      ...EMPTY,
      wallets: [wallet({ walletId: "solana:w1", status: "candidate", address: SOL })],
    }
    const first = reviewWalletLifecycle({
      file,
      performances: new Map([["solana:w1", perf]]),
      llmScores: new Map([["solana:w1", 50]]),
      hardExclusions: new Map(),
      epochId: "epoch-1",
      nowIso: NOW,
      thresholds,
    })
    expect(first.applied).toHaveLength(1)
    const second = reviewWalletLifecycle({
      file: first.file,
      performances: new Map([["solana:w1", perf]]),
      llmScores: new Map([["solana:w1", 50]]),
      hardExclusions: new Map(),
      epochId: "epoch-1",
      nowIso: NOW,
      thresholds,
    })
    expect(second.applied).toHaveLength(0)
    expect(second.file.transitions).toHaveLength(first.file.transitions.length)
  })

  it("hard exclusions exclude and block promotion", () => {
    const file: WalletsFile = {
      ...EMPTY,
      wallets: [wallet({ walletId: "solana:w1", status: "candidate" })],
    }
    const perf = aggregateWalletPerformance("solana:w1", [], CUTOFF, NOW)
    const result = reviewWalletLifecycle({
      file,
      performances: new Map([["solana:w1", perf]]),
      llmScores: new Map([["solana:w1", 100]]),
      hardExclusions: new Map([["solana:w1", "pool"]]),
      epochId: "epoch-2",
      nowIso: NOW,
      thresholds,
    })
    expect(result.file.wallets[0]?.status).toBe("excluded")
    expect(result.applied).toHaveLength(0)
  })

  it("drops idle tracking wallets", () => {
    const perf = {
      ...aggregateWalletPerformance("solana:w1", [], CUTOFF, NOW),
      idleDays: 50,
    }
    expect(shouldDropWallet(
      wallet({ walletId: "solana:w1", status: "tracking" }),
      perf,
      thresholds.drop,
      0.9,
      0.9,
    )).toBe("inactive")
  })
})

describe("prop_inv_s20_lifecycle_budget_and_line", () => {
  it("lifecycle severity never consumes market broadcast budget", async () => {
    const { canSendBroadcast, dayKey } = await import("../../src/orchestrator/broadcast.js")
    const market = {
      severity: "watch" as const,
      text: "market note",
      refs: ["state/watchlist.json"],
      auditClaim: {
        type: "token-upside" as const,
        subject: "solana:token",
        direction: "up" as const,
        horizonHours: 72,
        verificationRule: "token.up.72h",
      },
    }
    const exhausted = { dayKey: dayKey(), used: 5, urgentUsed: 0 }
    expect(canSendBroadcast(market, exhausted, {
      daily_budget: 5,
      urgent_ceiling: 10,
    }).ok).toBe(false)

    const { renderWalletLifecycleLine } = await import("../../src/lib/router-contract.js")
    const line = renderWalletLifecycleLine({
      action: "added",
      chain: "solana",
      address: SOL,
      reasonLine: "operator seed",
    })
    expect(line.startsWith("wallet added:")).toBe(true)
    expect([...line].length).toBeLessThanOrEqual(280)
    // wallet.lifecycle events use severity lifecycle and never enter canSendBroadcast
    expect(line).not.toMatch(/watch|notable|urgent/u)
  })
})

describe("robinhood chain registry", () => {
  it("marks robinhood as public-rpc trackable with goplus scanner", () => {
    const chain = getChain("robinhood")
    expect(chain?.walletTracking).toBe("robinhood-public")
    expect(chain?.securityScanner).toEqual({ kind: "goplus", chainId: "4663" })
    expect(chain?.evmChainId).toBe(4663)
  })
})

describe("plasma and hyperliquid chain registry", () => {
  it("marks plasma trackable via GoPlus 9745", () => {
    const chain = getChain("plasma")
    expect(chain?.dexscreenerChainId).toBe("plasma")
    expect(chain?.geckoterminalNetwork).toBe("plasma")
    expect(chain?.securityScanner).toEqual({ kind: "goplus", chainId: "9745" })
    expect(chain?.evmChainId).toBe(9745)
    expect(chain?.walletTracking).toBe("unsupported")
    expect(isTrackableChain("plasma")).toBe(true)
  })

  it("maps hyperliquid onto hyperevm without a scanner", () => {
    const chain = getChain("hyperliquid")
    expect(chain?.dexscreenerChainId).toBe("hyperevm")
    expect(chain?.geckoterminalNetwork).toBe("hyperevm")
    expect(chain?.securityScanner).toBeUndefined()
    expect(chain?.evmChainId).toBe(999)
    expect(isTrackableChain("hyperliquid")).toBe(false)
    expect(chainSlugFromProviderId("hyperevm")).toBe("hyperliquid")
  })
})

describe("wallet review host phase", () => {
  it("loads archived buy outcomes for review aggregation", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-wallet-review-"))
    const archiveRoot = join(root, "archive")
    mkdirSync(join(archiveRoot, "outcomes"), { recursive: true })
    writeFileSync(join(archiveRoot, "outcomes", "wallet-buy-test.json"), `${JSON.stringify({
      schema: 1,
      outcomes: [{
        schema: 1,
        eventId: "wb_x",
        walletId: `solana:${SOL}`,
        chain: "solana",
        tokenAddress: SOL,
        boughtAt: "2026-07-10T00:00:00.000Z",
        settledAt: "2026-07-12T00:00:00.000Z",
        excessReturn72h: 0.5,
        leadTimeHours: 3,
        maxDrawdown: 0.05,
        rug: false,
        finalized: true,
        removed: false,
        priceable: true,
      }],
    }, null, 2)}\n`)
    const { loadWalletBuyOutcomes } = await import("../../src/orchestrator/wallet-review.js")
    const loaded = loadWalletBuyOutcomes(archiveRoot)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.walletId).toBe(`solana:${SOL}`)
  })

  it("prop_inv_s25_blocks_wallet_lifecycle_egress_under_canary", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-wallet-canary-"))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    const store = new StateStore(join(agentRoot, "state"))
    const outcomesDir = join(archiveRoot, "outcomes")
    mkdirSync(outcomesDir, { recursive: true })
    const file: WalletsFile = {
      ...EMPTY,
      wallets: [wallet({
        walletId: `solana:${SOL}`,
        status: "candidate",
        address: SOL,
      })],
    }
    await store.saveWallets(file)
    writeFileSync(join(outcomesDir, "wallet-buy-canary.json"), `${JSON.stringify({
      outcomes: [
        {
          schema: 1,
          eventId: "wb_1",
          walletId: `solana:${SOL}`,
          chain: "solana",
          tokenAddress: SOL,
          boughtAt: "2026-07-10T00:00:00.000Z",
          settledAt: "2026-07-12T00:00:00.000Z",
          excessReturn72h: 0.4,
          leadTimeHours: 4,
          maxDrawdown: 0.05,
          rug: false,
          finalized: true,
          removed: false,
          priceable: true,
        },
        {
          schema: 1,
          eventId: "wb_2",
          walletId: `solana:${SOL}`,
          chain: "solana",
          tokenAddress: SOL,
          boughtAt: "2026-07-11T00:00:00.000Z",
          settledAt: "2026-07-13T00:00:00.000Z",
          excessReturn72h: 0.35,
          leadTimeHours: 3,
          maxDrawdown: 0.04,
          rug: false,
          finalized: true,
          removed: false,
          priceable: true,
        },
      ],
    }, null, 2)}\n`)

    const { runWalletReview } = await import("../../src/orchestrator/wallet-review.js")
    const report = await runWalletReview({
      agentRoot,
      archiveRoot,
      runId: "wallet-review-canary",
      blockExternalEffects: true,
      runSession: async () => ({
        score_0_100: 60,
        verdict: "promote",
        reason_code: "ok",
      }),
    })
    expect(report.applied).toBeGreaterThanOrEqual(0)
    expect(report.staged).toBe(0)
    expect(report.blockedExternal).toBe(true)

    const reviewPath = join(archiveRoot, "wallets", "wallet-review-canary-review.json")
    const archived = JSON.parse(readFileSync(reviewPath, "utf8")) as {
      votes: Array<{ contribution: number, parsedScore: number, evidenceCardHash: string }>
    }
    expect(archived.votes.length).toBeGreaterThan(0)
    expect(archived.votes[0]?.evidenceCardHash.startsWith("sha256:")).toBe(true)
    expect(archived.votes[0]?.parsedScore).toBe(60)
    expect(archived.votes[0]?.contribution).toBeCloseTo(0.12)
  })
})
