import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, mkdirSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SnapshotWriter } from "../../src/lib/snapshot.js"
import { StateStore } from "../../src/lib/state.js"
import { collectChartSweep } from "../../src/orchestrator/chart-collect.js"
import { collectWatchlistScan } from "../../src/orchestrator/watchlist-collect.js"
import { runWalletDiscovery } from "../../src/orchestrator/wallet-discovery.js"
import { runWalletScan } from "../../src/orchestrator/wallet-scan.js"
import { runJob } from "../../src/orchestrator/run.js"
import { collectForJob } from "../../src/orchestrator/collect.js"

const NOW = "2026-07-18T12:00:00.000Z"

// Ambient operator keys (.env) enable the OHLCV fallback chain, whose real
// retry backoff makes failure-path tests slow and timing-dependent.
const savedEnv = { ...process.env }
beforeEach(() => {
  process.env = { ...savedEnv }
  delete process.env["SOLANATRACKER_API_KEY"]
  delete process.env["BIRDEYE_API_KEY"]
})
afterAll(() => {
  process.env = savedEnv
})

describe("empty collector prerequisites", () => {
  it("chart-sweep skips with no active subjects and zero network", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-chart-empty-"))
    const archive = mkdtempSync(join(tmpdir(), "tc-arch-"))
    mkdirSync(join(root, "state"), { recursive: true })
    mkdirSync(join(root, "reports"), { recursive: true })
    const state = new StateStore(join(root, "state"))
    await state.saveWatchlist({ schema: 1, entries: [] })
    const writer = new SnapshotWriter(root)
    let fetches = 0
    const result = await collectChartSweep({
      runId: "chart-sweep-2026-07-18T12-00-00-000Z",
      writer,
      fetchedAt: NOW,
      agentRoot: root,
      archiveRoot: archive,
      fetcher: async () => {
        fetches += 1
        return new Response("{}", { status: 200 })
      },
    })
    expect(fetches).toBe(0)
    expect(result.skipAgent).toBe(true)
    expect(result.collectionStatus).toBe("skipped")
    expect(result.snapshotNames).toContain("chart-collection-status")
  })

  it("watchlist-scan skips with no active subjects and zero network", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-watchlist-empty-"))
    mkdirSync(join(root, "state"), { recursive: true })
    const state = new StateStore(join(root, "state"))
    await state.saveWatchlist({ schema: 1, entries: [] })
    let fetches = 0
    const result = await collectWatchlistScan({
      runId: "watchlist-scan-2026-07-18T12-00-00-000Z",
      writer: new SnapshotWriter(root),
      fetchedAt: NOW,
      agentRoot: root,
      fetcher: async () => {
        fetches += 1
        return new Response("{}", { status: 200 })
      },
    })

    expect(fetches).toBe(0)
    expect(result.skipAgent).toBe(true)
    expect(result.collectionStatus).toBe("skipped")
    expect(result.snapshotNames).toContain("watchlist-collection-status")
  })

  it("chart-sweep writes a chart for a fixture watchlist subject", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tc-chart-active-")))
    const archive = mkdtempSync(join(tmpdir(), "tc-arch-active-"))
    mkdirSync(join(root, "state"), { recursive: true })
    const state = new StateStore(join(root, "state"))
    const identity = {
      chain: "solana" as const,
      tokenAddress: "So11111111111111111111111111111111111111112",
      pairAddress: "So11111111111111111111111111111111111111112",
      symbolDisplay: "SOL",
      resolution: "resolved" as const,
    }
    await state.saveWatchlist({
      schema: 1,
      entries: [{
        schema: 1,
        identity,
        status: "tracking",
        addedAt: NOW,
        updatedAt: NOW,
      }],
    })
    const asOf = Math.floor(Date.parse(NOW) / 1_000)
    const candles = Array.from({ length: 8 }, (_, index) => [
      asOf - (8 - index) * 900,
      100 + index,
      101 + index,
      99 + index,
      100.5 + index,
      1_000 + index,
    ])
    const result = await collectChartSweep({
      runId: "chart-sweep-active-1",
      writer: new SnapshotWriter(root),
      fetchedAt: NOW,
      agentRoot: root,
      archiveRoot: archive,
      fetcher: async () => new Response(JSON.stringify({
        data: { attributes: { ohlcv_list: candles } },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    })

    expect(result.chartsWritten).toBeGreaterThan(0)
    expect(result.skipAgent).toBe(false)
    expect(result.collectionStatus).toBe("completed")
  })

  it("chart-sweep degrades and skips the agent when the provider fails for every subject", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tc-chart-degraded-")))
    const archive = mkdtempSync(join(tmpdir(), "tc-arch-degraded-"))
    mkdirSync(join(root, "state"), { recursive: true })
    const state = new StateStore(join(root, "state"))
    await state.saveWatchlist({
      schema: 1,
      entries: [{
        schema: 1,
        identity: {
          chain: "solana" as const,
          tokenAddress: "So11111111111111111111111111111111111111112",
          pairAddress: "So11111111111111111111111111111111111111112",
          symbolDisplay: "SOL",
          resolution: "resolved" as const,
        },
        status: "tracking",
        addedAt: NOW,
        updatedAt: NOW,
      }],
    })
    const result = await collectChartSweep({
      runId: "chart-sweep-degraded-1",
      writer: new SnapshotWriter(root),
      fetchedAt: NOW,
      agentRoot: root,
      archiveRoot: archive,
      fetcher: async () => new Response("provider down", { status: 503 }),
    })

    expect(result.subjectsConsidered).toBe(1)
    expect(result.chartsWritten).toBe(0)
    expect(result.collectionStatus).toBe("degraded")
    expect(result.skipAgent).toBe(true)
    expect(result.snapshotNames).toContain("chart-collection-status")
    expect(existsSync(join(root, "reports", "chart-sweep-degraded-1", "chart-sweep-host.json"))).toBe(true)
  }, 20_000)

  it("wallet discovery reports no-active-watchlist-subjects", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-wd-"))
    const archive = mkdtempSync(join(tmpdir(), "tc-wda-"))
    mkdirSync(join(root, "state"), { recursive: true })
    const state = new StateStore(join(root, "state"))
    await state.saveWatchlist({ schema: 1, entries: [] })
    await state.saveWallets({
      schema: 1,
      wallets: [],
      transitions: [],
      pendingTransitionIds: [],
      cursors: [],
      exclusions: [],
    })
    const report = await runWalletDiscovery({
      agentRoot: root,
      archiveRoot: archive,
      runId: "wallet-discovery-2026-07-18T12-00-00-000Z",
    })
    expect(report.status).toBe("skipped")
    expect(report.skippedReason).toBe("no-active-watchlist-subjects")
    expect(report.providerAttempts).toBe(0)
  })

  it("wallet scan reports wallet-state-empty", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-ws-"))
    const archive = mkdtempSync(join(tmpdir(), "tc-wsa-"))
    mkdirSync(join(root, "state"), { recursive: true })
    const state = new StateStore(join(root, "state"))
    await state.saveWallets({
      schema: 1,
      wallets: [],
      transitions: [],
      pendingTransitionIds: [],
      cursors: [],
      exclusions: [],
    })
    const report = await runWalletScan({
      agentRoot: root,
      archiveRoot: archive,
      runId: "wallet-scan-solana-2026-07-18T12-00-00-000Z",
      family: "solana",
    })
    expect(report.status).toBe("skipped")
    expect(report.skippedReason).toBe("wallet-state-empty")
  })

  it("skips an empty wallet scan before creating agent artifacts", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-wallet-run-empty-"))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    const state = new StateStore(join(agentRoot, "state"))
    await state.saveWallets({
      schema: 1,
      wallets: [],
      transitions: [],
      pendingTransitionIds: [],
      cursors: [],
      exclusions: [],
    })

    const result = await runJob({
      job: "wallet-scan-solana",
      paths: { agentRoot, archiveRoot },
    })

    expect(result).toMatchObject({ runId: "none", exitCode: 0 })
    expect(existsSync(join(agentRoot, "reports"))).toBe(false)
  })

  it("writes usable wallet evidence when an eligible wallet exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-wallet-evidence-"))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    const state = new StateStore(join(agentRoot, "state"))
    await state.saveWallets({
      schema: 1,
      wallets: [{
        schema: 1,
        walletId: "solana:11111111111111111111111111111111",
        chain: "solana",
        address: "11111111111111111111111111111111",
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
    const collection = await collectForJob({
      job: "wallet-scan-solana",
      runId: "wallet-scan-solana-2026-07-18T12-00-00-000Z",
      writer: new SnapshotWriter(agentRoot),
      fetchedAt: NOW,
      agentRoot,
      archiveRoot,
    })

    expect(collection.skipAgent).not.toBe(true)
    expect(collection.snapshotNames).toContain("wallet-evidence-wallet-scan-solana")
    expect(existsSync(join(
      agentRoot,
      "inbox",
      "wallet-scan-solana-2026-07-18T12-00-00-000Z",
      "wallet-evidence-wallet-scan-solana.json",
    ))).toBe(true)
  })

  it("keeps empty health in review scope at precheck", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-review-run-empty-"))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    mkdirSync(join(agentRoot, "state"), { recursive: true })
    const state = new StateStore(join(agentRoot, "state"))
    await state.saveWatchlist({ schema: 1, entries: [] })

    const { precheckJob } = await import("../../src/orchestrator/preconditions.js")
    const decision = await precheckJob({
      job: "review",
      agentRoot,
      archiveRoot,
    })
    // Empty queues / silent wallets are health findings, not a skip
    expect(decision?.skip).not.toBe(true)
    expect(existsSync(join(agentRoot, "reports"))).toBe(false)
  })

  it("skips chart-sweep and watchlist-scan before creating agent artifacts", async () => {
    for (const job of ["chart-sweep", "watchlist-scan"] as const) {
      const root = mkdtempSync(join(tmpdir(), `tc-${job}-run-empty-`))
      const agentRoot = join(root, "agent")
      const archiveRoot = join(root, "archive")
      mkdirSync(join(agentRoot, "state"), { recursive: true })
      const state = new StateStore(join(agentRoot, "state"))
      await state.saveWatchlist({ schema: 1, entries: [] })

      const result = await runJob({
        job,
        paths: { agentRoot, archiveRoot },
      })

      expect(result).toMatchObject({ runId: "none", exitCode: 0 })
      expect(existsSync(join(agentRoot, "reports"))).toBe(false)
      expect(existsSync(join(archiveRoot, "skips", `${job}.jsonl`))).toBe(true)
    }
  })
})
