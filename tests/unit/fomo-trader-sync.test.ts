import { describe, expect, it, beforeEach } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SnapshotWriter } from "../../src/lib/snapshot.js"
import { ConfigSchema, type TrenchcoatConfig } from "../../src/lib/config.js"
import { collectFomoTraderSync } from "../../src/orchestrator/fomo-trader-collect.js"
import { resetRateGatesForTests } from "../../src/lib/rate-gate.js"
import { saveFomoGates } from "../../src/collectors/fomo/gates.js"
import type { FomoDataSource } from "../../src/collectors/fomo/web-client.js"
import type { FomoGatesFile, FomoLeaderboardEntry } from "../../src/collectors/fomo/types.js"

const seed = JSON.parse(
  readFileSync(join(process.cwd(), "config/seed.example.json"), "utf8"),
) as Record<string, unknown>

function shadowTraderConfig(): TrenchcoatConfig {
  const base = ConfigSchema.parse(seed)
  return {
    ...base,
    fomo: {
      ...base.fomo,
      enabled: true,
      shadow_mode: true,
      trader_sync: { ...base.fomo.trader_sync, enabled: true },
      x_source_review: { ...base.fomo.x_source_review, enabled: true },
    },
  }
}

function failGates(probeRunId: string): FomoGatesFile {
  return {
    schema: 2,
    probeRunId,
    evaluatedAt: new Date().toISOString(),
    fixtureHashes: {},
    gates: {
      provider: { verdict: "fail", sampleSize: 3, successRate: 0 },
      leaderboard: { verdict: "insufficient-sample", sampleSize: 0 },
      feed: { verdict: "insufficient-sample", sampleSize: 0 },
      trending: { verdict: "insufficient-sample", sampleSize: 0 },
      alerts: { verdict: "insufficient-sample", sampleSize: 0 },
      theses: { verdict: "insufficient-sample", sampleSize: 0 },
    },
  }
}

function mockClient(entries: readonly FomoLeaderboardEntry[] = []): FomoDataSource {
  return {
    getLeaderboard: async () => [...entries],
    getHandleStats: async () => undefined,
    getHotTokens: async () => [],
    getActivity: async () => [],
    pollActivity: async () => ({ count: 0 }),
    getConvergence: async () => [],
    getTrendingHandles: async () => [],
    readLeaderboard: async () => [...entries],
    readFeed: async () => [],
    readTrending: async () => [],
    readAlerts: async () => [],
    readProfile: async () => undefined,
    readProfileCalls: async () => [],
    remainingToday: async () => 100,
    close: async () => undefined,
  }
}

describe("fomo trader sync host-only", () => {
  beforeEach(() => {
    resetRateGatesForTests()
  })

  it("skips when provider gate fails without mutating wallets", async () => {
    const root = mkdtempSync(join(tmpdir(), "fomo-trader-"))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    mkdirSync(join(agentRoot, "inbox"), { recursive: true })
    mkdirSync(join(agentRoot, "state"), { recursive: true })
    writeFileSync(join(agentRoot, "state", "wallets.json"), JSON.stringify({
      schema: 1,
      wallets: [],
      transitions: [],
      pendingTransitionIds: [],
      cursors: [],
      exclusions: [],
    }))
    await saveFomoGates(archiveRoot, failGates("test"))

    const writer = new SnapshotWriter(agentRoot)
    const summary = await collectFomoTraderSync({
      runId: "fomo-trader-sync-test",
      writer,
      fetchedAt: "2026-07-18T00:00:00.000Z",
      agentRoot,
      archiveRoot,
      config: shadowTraderConfig(),
      client: mockClient(),
    })
    expect(summary.skipAgent).toBe(true)
    expect(summary.collectionKind).toBe("host-only")
  })

  it("shadow mode writes leaderboard receipt without wallet or nomination mutation", async () => {
    const root = mkdtempSync(join(tmpdir(), "fomo-trader-shadow-"))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    mkdirSync(join(agentRoot, "inbox"), { recursive: true })
    mkdirSync(join(agentRoot, "state"), { recursive: true })
    const wallets = JSON.stringify({
      schema: 1,
      wallets: [],
      transitions: [],
      pendingTransitionIds: [],
      cursors: [],
      exclusions: [],
    })
    const nominations = JSON.stringify({ schema: 1, nominations: [] })
    writeFileSync(join(agentRoot, "state", "wallets.json"), wallets)
    writeFileSync(join(agentRoot, "state", "x-source-nominations.json"), nominations)
    await saveFomoGates(archiveRoot, {
      ...failGates("shadow"),
      gates: {
        provider: { verdict: "pass", sampleSize: 30, successRate: 0.99 },
        leaderboard: { verdict: "pass", sampleSize: 30 },
        feed: { verdict: "pass", sampleSize: 30 },
        trending: { verdict: "pass", sampleSize: 30 },
        alerts: { verdict: "pass", sampleSize: 30 },
        theses: { verdict: "fail", sampleSize: 0 },
      },
    })

    const writer = new SnapshotWriter(agentRoot)
    const summary = await collectFomoTraderSync({
      runId: "fomo-trader-sync-shadow",
      writer,
      fetchedAt: "2026-07-19T00:00:00.000Z",
      agentRoot,
      archiveRoot,
      config: shadowTraderConfig(),
      client: mockClient([{
        handle: "alpha",
        xHandle: "alpha_x",
        timeframe: "7d",
        rank: 1,
        wallets: [],
        observedAt: "2026-07-19T00:00:00.000Z",
      }]),
    })

    expect(summary.collectionStatus).toBe("fomo-shadow")
    expect(summary.snapshotNames).toContain("fomo-leaderboard")
    expect(readFileSync(join(agentRoot, "state", "wallets.json"), "utf8")).toBe(wallets)
    expect(readFileSync(join(agentRoot, "state", "x-source-nominations.json"), "utf8")).toBe(nominations)
    const inbox = readFileSync(
      join(agentRoot, "inbox", "fomo-trader-sync-shadow", "fomo-leaderboard.json"),
      "utf8",
    )
    expect(inbox).toContain("handle=alpha")
    expect(inbox).toContain("xHandle=alpha_x")
    expect(inbox).not.toMatch(/chain=|address=/u)
  })
})
