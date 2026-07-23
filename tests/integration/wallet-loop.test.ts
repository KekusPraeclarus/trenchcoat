import { describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StateStore } from "../../src/lib/state.js"
import { registerWalletCandidates } from "../../src/wallets/discovery.js"
import { aggregateWalletPerformance } from "../../src/wallets/outcomes.js"
import { reviewWalletLifecycle } from "../../src/wallets/review.js"
import { Outbox } from "../../src/lib/outbox.js"
import { transitionToRouterEvent } from "../../src/wallets/lifecycle.js"
import type { WalletBuyOutcome, WalletsFile } from "../../src/contracts/schemas.js"
import { SnapshotWriter } from "../../src/lib/snapshot.js"
import { collectForJob } from "../../src/orchestrator/collect.js"
import { SnapshotEnvelopeSchema } from "../../src/contracts/schemas.js"
import { readFileSync } from "node:fs"

const SOL = "11111111111111111111111111111111"
const NOW = "2026-07-16T18:00:00.000Z"

describe("wallet discovery loop integration", () => {
  it("candidate → scored → promoted → router staged", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-wallet-loop-"))
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
      { chain: "solana", address: SOL, origin: "watchlist", tokenAddress: SOL },
    ], NOW)
    await store.saveWallets(file)

    const outcomesDir = join(root, "outcomes")
    mkdirSync(outcomesDir, { recursive: true })
    const outcomes: WalletBuyOutcome[] = Array.from({ length: 3 }, (_, i) => ({
      schema: 1 as const,
      eventId: `wb_${i}`,
      walletId: `solana:${SOL}`,
      chain: "solana" as const,
      tokenAddress: SOL,
      boughtAt: `2026-07-1${i}T00:00:00.000Z`,
      settledAt: `2026-07-1${i + 1}T00:00:00.000Z`,
      realizedReturn: 0.35,
      leadTimeHours: 5,
      maxDrawdown: 0.05,
      rug: false,
      finalized: true,
      removed: false,
      priceable: true,
    }))
    writeFileSync(join(outcomesDir, "wallet-buy-loop.json"), `${JSON.stringify({ outcomes }, null, 2)}\n`)

    const loaded = store.loadWallets()
    const perf = aggregateWalletPerformance(
      `solana:${SOL}`,
      outcomes,
      NOW,
      NOW,
    )
    const reviewed = reviewWalletLifecycle({
      file: loaded,
      performances: new Map([[`solana:${SOL}`, perf]]),
      llmScores: new Map([[`solana:${SOL}`, 60]]),
      hardExclusions: new Map(),
      epochId: "loop-1",
      nowIso: NOW,
      thresholds: {
        max_transitions_per_review: 10,
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
          max_idle_days: 60,
        },
        drop: {
          idle_days: 90,
          rug_exposure: 0.5,
          coverage_floor: 0.1,
          deterministic_floor: 0.1,
          blended_floor: 0.1,
          readd_cooldown_days: 30,
          readd_min_new_events: 5,
        },
      },
    })
    await store.saveWallets(reviewed.file)
    expect(store.loadWallets().wallets[0]?.status).toBe("tracking")

    const outbox = new Outbox(join(root, "router-outbox"))
    for (const transition of reviewed.applied) {
      await outbox.stage(transitionToRouterEvent(transition))
    }
    expect(outbox.list()).toHaveLength(reviewed.applied.length)
    expect(outbox.list()[0]?.type).toBe("wallet.lifecycle")
  })

  it("empty wallet scan exits without agent stubs", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-wallet-empty-skip-"))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    const home = join(root, "home")
    mkdirSync(join(agentRoot, "state"), { recursive: true })
    mkdirSync(join(agentRoot, "reports"), { recursive: true })
    mkdirSync(join(agentRoot, "inbox"), { recursive: true })
    writeFileSync(join(agentRoot, "state", "wallets.json"), `${JSON.stringify({
      schema: 1,
      wallets: [],
      transitions: [],
      pendingTransitionIds: [],
      cursors: [],
      exclusions: [],
    }, null, 2)}\n`)
    writeFileSync(join(agentRoot, "state", "watchlist.json"), `${JSON.stringify({ schema: 1, entries: [] }, null, 2)}\n`)
    writeFileSync(join(agentRoot, "AGENTS.md"), "# test\n")

    const { runJob } = await import("../../src/orchestrator/run.js")
    const result = await runJob({
      job: "wallet-scan-solana",
      paths: { agentRoot, archiveRoot },
      skipAgent: true,
    })
    expect(result.exitCode).toBe(0)
    expect(result.runId).toBe("none")
    expect(existsSync(join(agentRoot, "reports"))).toBe(true)
    const { readdirSync } = await import("node:fs")
    expect(readdirSync(join(agentRoot, "reports"))).toHaveLength(0)
    void home
  }, 15_000)

  it("keeps evidence reports outside the wallet lifecycle", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-wallet-evidence-loop-"))
    const agentRoot = root
    const archiveRoot = join(root, "archive")
    const store = new StateStore(join(agentRoot, "state"))
    await store.saveWallets({
      schema: 1,
      wallets: [{
        schema: 1,
        walletId: `solana:${SOL}`,
        chain: "solana",
        address: SOL,
        status: "candidate",
        addedAt: NOW,
        updatedAt: NOW,
        hardExcluded: false,
      }],
      transitions: [],
      pendingTransitionIds: [],
      cursors: [],
      exclusions: [],
    })

    const runId = "wallet-scan-solana-2026-07-16T18-00-00-000Z"
    const collection = await collectForJob({
      job: "wallet-scan-solana",
      runId,
      writer: new SnapshotWriter(agentRoot),
      fetchedAt: NOW,
      agentRoot,
      archiveRoot,
    })

    expect(collection.skipAgent).not.toBe(true)
    const evidencePath = join(
      agentRoot,
      "inbox",
      runId,
      "wallet-evidence-wallet-scan-solana.json",
    )
    expect(existsSync(evidencePath)).toBe(true)

    // the evidence the agent receives must pass the inbox contract and carry the
    // eligible wallet so a downstream agent run can act on it
    const envelope = SnapshotEnvelopeSchema.parse(JSON.parse(readFileSync(evidencePath, "utf8")))
    expect(envelope.source).toBe("host.wallet-evidence")
    const evidence = JSON.parse(envelope.items[0]!.text) as {
      job: string
      eligibleWalletIds: string[]
    }
    expect(evidence.job).toBe("wallet-scan-solana")
    expect(evidence.eligibleWalletIds).toContain(`solana:${SOL}`)
    expect(store.loadWallets().wallets[0]?.status).toBe("candidate")
  })

  it("tracked-wallet convergence is deterministic and idempotent by convergenceId", async () => {
    const { deriveWalletBuyConvergence } = await import("../../src/wallets/convergence.js")
    const { sha256Json } = await import("../../src/lib/canonical-json.js")
    const { renderWalletConvergenceLine } = await import("../../src/lib/router-contract.js")
    const TOKEN = "Token1111111111111111111111111111111111111"
    const outcomes: WalletBuyOutcome[] = ["w1", "w2", "w3", "w4"].map((id, i) => ({
      schema: 1 as const,
      eventId: `wb_${id}`,
      walletId: `solana:${id}`,
      chain: "solana" as const,
      tokenAddress: TOKEN,
      boughtAt: `2026-07-16T17:0${i}:00.000Z`,
      finalized: true,
      removed: false,
      priceable: true,
      rug: false,
      walletStatusAtEvent: "tracking" as const,
      providerEventId: `prov_${id}`,
    }))
    const opts = {
      minWallets: 4,
      windowMinutes: 15,
      maxTokenAgeHours: 24,
      nowIso: NOW,
      hash: (p: unknown) => sha256Json(p as never),
    }
    const first = deriveWalletBuyConvergence(outcomes, opts)
    const second = deriveWalletBuyConvergence([...outcomes].reverse(), opts)
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    expect(first[0]?.convergenceId).toBe(second[0]?.convergenceId)
    const line = renderWalletConvergenceLine({
      chain: first[0]!.chain,
      tokenAddress: first[0]!.tokenAddress,
      walletCount: first[0]!.walletIds.length,
      windowMinutes: 15,
    })
    expect(line.startsWith("UNVERIFIED WALLET CONVERGENCE:")).toBe(true)

    const root = mkdtempSync(join(tmpdir(), "tc-wallet-conv-idem-"))
    const store = new StateStore(join(root, "state"))
    await store.saveWalletRunners({
      schema: 1,
      pools: [],
      sightings: [],
      cursors: [],
      alertedConvergenceIds: [first[0]!.convergenceId],
      enqueuedConvergenceIds: [first[0]!.convergenceId],
      cooldownUntilByToken: {},
    })
    expect(store.loadWalletRunners().alertedConvergenceIds).toEqual([first[0]!.convergenceId])
  })
})
