import { describe, expect, it, beforeEach } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SnapshotWriter } from "../../src/lib/snapshot.js"
import { ConfigSchema, type TrenchcoatConfig } from "../../src/lib/config.js"
import { collectFomoSignalScan } from "../../src/orchestrator/fomo-signal-collect.js"
import { collectFomoTraderSync } from "../../src/orchestrator/fomo-trader-collect.js"
import { resetRateGatesForTests } from "../../src/lib/rate-gate.js"
import { saveFomoGates } from "../../src/collectors/fomo/gates.js"
import type { FomoDataSource } from "../../src/collectors/fomo/web-client.js"
import type { FomoGatesFile, FomoTradeEvent } from "../../src/collectors/fomo/types.js"

const SOL = "So11111111111111111111111111111111111111112"
const seed = JSON.parse(
  readFileSync(join(process.cwd(), "config/seed.example.json"), "utf8"),
) as Record<string, unknown>

function shadowConfig(overrides: {
  traderSync?: boolean
  signalScan?: boolean
  xSourceReview?: boolean
} = {}): TrenchcoatConfig {
  const base = ConfigSchema.parse(seed)
  return {
    ...base,
    fomo: {
      ...base.fomo,
      enabled: true,
      shadow_mode: true,
      trader_sync: {
        ...base.fomo.trader_sync,
        enabled: overrides.traderSync ?? true,
      },
      signal_scan: {
        ...base.fomo.signal_scan,
        enabled: overrides.signalScan ?? true,
        feed: true,
        convergence: true,
      },
      x_source_review: {
        ...base.fomo.x_source_review,
        enabled: overrides.xSourceReview ?? true,
      },
    },
  }
}

function passGates(): FomoGatesFile {
  const now = new Date().toISOString()
  return {
    schema: 2,
    probeRunId: "test",
    evaluatedAt: now,
    fixtureHashes: {},
    gates: {
      provider: { verdict: "pass", sampleSize: 30, successRate: 0.99 },
      leaderboard: { verdict: "pass", sampleSize: 30 },
      feed: { verdict: "pass", sampleSize: 30 },
      trending: { verdict: "pass", sampleSize: 30 },
      alerts: { verdict: "insufficient-sample", sampleSize: 0 },
      theses: { verdict: "fail", sampleSize: 0 },
    },
  }
}

function mockSignalClient(trades: readonly FomoTradeEvent[]): FomoDataSource {
  return {
    getLeaderboard: async () => [
      { handle: "a", timeframe: "7d", rank: 1, wallets: [], observedAt: "2026-07-19T10:00:00.000Z" },
      { handle: "b", timeframe: "7d", rank: 2, wallets: [], observedAt: "2026-07-19T10:00:00.000Z" },
    ],
    getHandleStats: async () => undefined,
    getHotTokens: async () => [],
    getActivity: async () => [],
    pollActivity: async () => ({ count: 0 }),
    getConvergence: async () => [],
    getTrendingHandles: async () => [],
    readLeaderboard: async () => [
      { handle: "a", timeframe: "7d", rank: 1, wallets: [], observedAt: "2026-07-19T10:00:00.000Z" },
      { handle: "b", timeframe: "7d", rank: 2, wallets: [], observedAt: "2026-07-19T10:00:00.000Z" },
    ],
    readFeed: async () => [...trades],
    readTrending: async () => [],
    readAlerts: async () => [],
    readProfile: async () => undefined,
    readProfileCalls: async () => [],
    remainingToday: async () => 100,
    close: async () => undefined,
  }
}

function mockTraderClient(): FomoDataSource {
  return {
    getLeaderboard: async () => [{
      handle: "alpha",
      xHandle: "alpha_x",
      timeframe: "7d",
      rank: 1,
      wallets: [],
      observedAt: "2026-07-19T10:00:00.000Z",
      trades: 40,
      winRate: 0.7,
    }],
    getHandleStats: async () => undefined,
    getHotTokens: async () => [],
    getActivity: async () => [],
    pollActivity: async () => ({ count: 0 }),
    getConvergence: async () => [],
    getTrendingHandles: async () => [],
    readLeaderboard: async () => [],
    readFeed: async () => [],
    readTrending: async () => [],
    readAlerts: async () => [],
    readProfile: async () => undefined,
    readProfileCalls: async () => [],
    remainingToday: async () => 100,
    close: async () => undefined,
  }
}

function seedMutableState(agentRoot: string): Readonly<Record<string, string>> {
  const stateDir = join(agentRoot, "state")
  mkdirSync(stateDir, { recursive: true })
  const files: Record<string, string> = {
    "research-queue.json": JSON.stringify({ schema: 1, entries: [] }),
    "watchlist.json": JSON.stringify({ schema: 1, entries: [] }),
    "wallets.json": JSON.stringify({
      schema: 1,
      wallets: [],
      transitions: [],
      pendingTransitionIds: [],
      cursors: [],
      exclusions: [],
    }),
    "x-source-nominations.json": JSON.stringify({ schema: 1, nominations: [] }),
    "sources.json": JSON.stringify({ schema: 1, accounts: [] }),
    "x-engagement.json": JSON.stringify({
      schema: 1,
      likedPostIds: [],
      followedHandles: [],
      lastLikedAt: {},
      lastFollowedAt: {},
      pendingActionIds: [],
      decisions: [],
      receipts: [],
      daily: { day: "2026-07-19", likes: 0, follows: 0, unfollows: 0 },
    }),
  }
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(stateDir, name), body)
  }
  return files
}

describe("fomo collect shadow integration", () => {
  beforeEach(() => {
    resetRateGatesForTests()
  })

  it("leaves host mutable state byte-identical in shadow signal scan", async () => {
    const root = mkdtempSync(join(tmpdir(), "fomo-collect-signal-"))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    mkdirSync(join(agentRoot, "inbox"), { recursive: true })
    const before = seedMutableState(agentRoot)
    await saveFomoGates(archiveRoot, passGates())

    const writer = new SnapshotWriter(agentRoot)
    const summary = await collectFomoSignalScan({
      runId: "fomo-signal-scan-shadow",
      writer,
      fetchedAt: "2026-07-19T10:30:00.000Z",
      agentRoot,
      archiveRoot,
      config: shadowConfig({ signalScan: true, traderSync: false }),
      client: mockSignalClient([{
        sourceId: "t1",
        handle: "a",
        action: "buy",
        chain: "solana",
        tokenAddress: SOL,
        eventAt: "2026-07-19T10:00:00.000Z",
        observedAt: "2026-07-19T10:00:00.000Z",
        usdAmount: 1_000,
      }]),
    })

    expect(summary.collectionStatus).toMatch(/^fomo-shadow/)
    expect(summary.snapshotNames.length).toBeGreaterThan(0)
    for (const [name, body] of Object.entries(before)) {
      expect(readFileSync(join(agentRoot, "state", name), "utf8")).toBe(body)
    }
    expect(existsSync(join(agentRoot, "state", "broadcast-budget.json"))).toBe(false)
  })

  it("writes nomination receipts without wallet or source-list mutation in shadow trader sync", async () => {
    const root = mkdtempSync(join(tmpdir(), "fomo-collect-trader-"))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    mkdirSync(join(agentRoot, "inbox"), { recursive: true })
    const before = seedMutableState(agentRoot)
    await saveFomoGates(archiveRoot, passGates())

    const writer = new SnapshotWriter(agentRoot)
    const summary = await collectFomoTraderSync({
      runId: "fomo-trader-sync-shadow",
      writer,
      fetchedAt: "2026-07-19T10:00:00.000Z",
      agentRoot,
      archiveRoot,
      config: shadowConfig({ traderSync: true, xSourceReview: true }),
      client: mockTraderClient(),
    })

    expect(summary.collectionStatus).toBe("fomo-shadow")
    expect(summary.snapshotNames).toContain("fomo-leaderboard")
    for (const [name, body] of Object.entries(before)) {
      expect(readFileSync(join(agentRoot, "state", name), "utf8")).toBe(body)
    }
  })
})
