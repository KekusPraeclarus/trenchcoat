import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StateStore } from "../../src/lib/state.js"
import { registerWalletCandidates } from "../../src/wallets/discovery.js"
import { Outbox } from "../../src/lib/outbox.js"
import { buildWalletTransition, transitionToRouterEvent } from "../../src/wallets/lifecycle.js"
import { sha256Json } from "../../src/lib/canonical-json.js"
import { deriveWalletBuyConvergence } from "../../src/wallets/convergence.js"
import type { WalletBuyOutcome, WalletRunnersFile, WalletsFile } from "../../src/contracts/schemas.js"

const SOL = "11111111111111111111111111111111"
const TOKEN = "Token1111111111111111111111111111111111111"

describe("wallet discovery crash resume", () => {
  it("persists cursors so a second pass resumes from checkpoint", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-wallet-cursor-"))
    const store = new StateStore(join(root, "state"))
    let file: WalletsFile = {
      schema: 1,
      wallets: [],
      transitions: [],
      pendingTransitionIds: [],
      cursors: [],
      exclusions: [],
    }
    file = registerWalletCandidates(file, [
      { chain: "solana", address: SOL, origin: "watchlist" },
    ], "2026-07-16T18:00:00.000Z")
    file = {
      ...file,
      cursors: [{
        schema: 1,
        chain: "solana",
        kind: "token-discovery",
        subject: SOL,
        cursor: "sig-checkpoint-1",
        updatedAt: "2026-07-16T18:00:00.000Z",
      }],
    }
    await store.saveWallets(file)
    const reloaded = store.loadWallets()
    expect(reloaded.cursors[0]?.cursor).toBe("sig-checkpoint-1")
    expect(reloaded.wallets[0]?.status).toBe("candidate")
  })

  it("stages idempotent wallet.lifecycle router events", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-wallet-outbox-"))
    const outbox = new Outbox(join(root, "outbox"))
    const wallet = {
      schema: 1 as const,
      walletId: `solana:${SOL}`,
      chain: "solana" as const,
      address: SOL,
      status: "tracking" as const,
      addedAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
      hardExcluded: false,
    }
    const transition = buildWalletTransition({
      wallet,
      action: "added",
      reasonCode: "promoted",
      reasonLine: "promoted from discovery candidate",
      occurredAt: "2026-07-16T18:00:00.000Z",
      runId: "run-1",
      evidenceHash: sha256Json({ walletId: wallet.walletId, action: "added" }),
    })
    await outbox.stage(transitionToRouterEvent(transition))
    await outbox.stage(transitionToRouterEvent(transition))
    const events = outbox.list()
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe("wallet.lifecycle")
  })

  it("runner pool checkpoint survives interrupt mid-run", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-runner-ckpt-"))
    const store = new StateStore(join(root, "state"))
    const runners: WalletRunnersFile = {
      schema: 1,
      pools: [{
        schema: 1,
        runnerId: "rn_partial",
        chain: "solana",
        poolAddress: SOL,
        tokenAddress: TOKEN,
        pairAddress: SOL,
        firstSeenAt: "2026-07-21T12:00:00.000Z",
        qualifiedAt: "2026-07-21T12:05:00.000Z",
        liquidityUsd: 60_000,
        return6h: 1.2,
        volume6hUsd: 300_000,
      }],
      sightings: [],
      cursors: [{
        schema: 1,
        chain: "solana",
        kind: "runner-discovery",
        subject: TOKEN,
        cursor: "sig-page-2",
        updatedAt: "2026-07-21T12:10:00.000Z",
      }],
      alertedConvergenceIds: [],
      enqueuedConvergenceIds: [],
      cooldownUntilByToken: {},
    }
    await store.saveWalletRunners(runners)
    const reloaded = store.loadWalletRunners()
    expect(reloaded.pools).toHaveLength(1)
    expect(reloaded.cursors[0]?.cursor).toBe("sig-page-2")
  })

  it("convergence alert cursor prevents duplicate effects after crash", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-conv-ckpt-"))
    const store = new StateStore(join(root, "state"))
    const outcomes: WalletBuyOutcome[] = ["w1", "w2", "w3", "w4"].map((id, i) => ({
      schema: 1 as const,
      eventId: `wb_${id}`,
      walletId: id,
      chain: "solana" as const,
      tokenAddress: TOKEN,
      boughtAt: `2026-07-21T17:0${i}:00.000Z`,
      finalized: true,
      removed: false,
      priceable: true,
      rug: false,
      walletStatusAtEvent: "tracking" as const,
    }))
    const signals = deriveWalletBuyConvergence(outcomes, {
      minWallets: 4,
      windowMinutes: 15,
      maxTokenAgeHours: 24,
      nowIso: "2026-07-21T18:00:00.000Z",
      hash: (p) => sha256Json(p as never),
    })
    expect(signals).toHaveLength(1)
    const cid = signals[0]!.convergenceId
    await store.saveWalletRunners({
      schema: 1,
      pools: [],
      sightings: [],
      cursors: [],
      alertedConvergenceIds: [cid],
      enqueuedConvergenceIds: [cid],
      cooldownUntilByToken: { [`solana:${TOKEN.toLowerCase()}`]: "2026-07-21T23:00:00.000Z" },
      alertsToday: { day: "2026-07-21", count: 1 },
      enqueuesToday: { day: "2026-07-21", count: 1 },
    })
    const again = store.loadWalletRunners()
    expect(again.alertedConvergenceIds).toContain(cid)
    expect(again.enqueuedConvergenceIds).toContain(cid)
  })
})
