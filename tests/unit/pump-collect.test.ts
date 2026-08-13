import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SnapshotWriter } from "../../src/lib/snapshot.js"
import { ConfigSchema, type TrenchcoatConfig } from "../../src/lib/config.js"
import { collectPumpScan } from "../../src/orchestrator/pump-collect.js"
import { savePumpGates } from "../../src/collectors/pump/gates.js"
import type { PumpDataSource, PumpFeedItem, PumpGatesFile } from "../../src/collectors/pump/types.js"
import { StateStore } from "../../src/lib/state.js"
import { ensureArchive } from "../../src/lib/archive.js"

const MINT = "EN2nnxrg8uUi6x2sJkzNPd2eT6rB9rdSoQNNaENA4RZA"
const NOW = "2026-08-13T12:00:00.000Z"
const seed = JSON.parse(
  readFileSync(join(process.cwd(), "config/seed.example.json"), "utf8"),
) as Record<string, unknown>

function pumpConfig(overrides?: Partial<TrenchcoatConfig["pump"]>): TrenchcoatConfig {
  const base = ConfigSchema.parse(seed)
  return {
    ...base,
    pump: {
      ...base.pump,
      enabled: true,
      shadow_mode: true,
      ...overrides,
    },
  }
}

function passGates(): PumpGatesFile {
  return {
    schema: 1,
    probeRunId: "test",
    evaluatedAt: NOW,
    fixtureHashes: {},
    gates: {
      provider: { verdict: "pass", sampleSize: 30, successRate: 0.99 },
      feed: { verdict: "pass", sampleSize: 30 },
      leaderboard: { verdict: "pass", sampleSize: 30 },
      following: { verdict: "pass", sampleSize: 30 },
    },
  }
}

function item(tab: PumpFeedItem["tab"], id: string, author: string): PumpFeedItem {
  return { itemId: id, author, tab, mint: MINT, chain: "solana", observedAt: NOW }
}

function mockClient(args?: {
  following?: readonly PumpFeedItem[]
}): PumpDataSource {
  return {
    readFeed: async ({ tab }) => {
      if (tab === "following") return [...(args?.following ?? [])]
      return [item(tab, `coin-${tab}`, `${tab}-author`)]
    },
    readLeaderboard: async () => [{ handle: "lb-alpha", rank: 1, observedAt: NOW }],
    readCallerProfile: async (handle) => ({
      handle,
      calls: [{
        callerId: handle,
        chain: "solana",
        tokenAddress: MINT,
        calledAt: NOW,
      }],
    }),
    close: async () => undefined,
  }
}

describe("pump-scan collect skip", () => {
  it("skips when pump is disabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "pump-skip-"))
    const agentRoot = join(root, "agent")
    mkdirSync(join(agentRoot, "inbox"), { recursive: true })
    const writer = new SnapshotWriter(agentRoot)
    const result = await collectPumpScan({
      runId: "pump-scan-1",
      writer,
      fetchedAt: NOW,
      agentRoot,
      archiveRoot: join(root, "archive"),
      config: pumpConfig({ enabled: false }),
      sessionExists: true,
      client: mockClient(),
    })
    expect(result.collectionStatus).toBe("pump-disabled")
    expect(result.skipAgent).toBe(true)
  })

  it("skips when session is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "pump-nosess-"))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    mkdirSync(join(agentRoot, "inbox"), { recursive: true })
    await savePumpGates(archiveRoot, passGates())
    const writer = new SnapshotWriter(agentRoot)
    const result = await collectPumpScan({
      runId: "pump-scan-2",
      writer,
      fetchedAt: NOW,
      agentRoot,
      archiveRoot,
      config: pumpConfig({ enabled: true }),
      sessionExists: false,
      client: mockClient(),
    })
    expect(result.collectionStatus).toBe("pump-missing-session")
  })
})

describe("pump-scan collect", () => {
  it("writes feeds, eligible snapshot, and archives calls in shadow without enqueue", async () => {
    const root = mkdtempSync(join(tmpdir(), "pump-collect-"))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    mkdirSync(join(agentRoot, "inbox"), { recursive: true })
    mkdirSync(join(agentRoot, "state"), { recursive: true })
    await savePumpGates(archiveRoot, passGates())
    const writer = new SnapshotWriter(agentRoot)
    const cursorsPath = join(root, "cursors.json")
    const result = await collectPumpScan({
      runId: "pump-scan-3",
      writer,
      fetchedAt: NOW,
      agentRoot,
      archiveRoot,
      config: pumpConfig({ enabled: true, shadow_mode: true }),
      sessionExists: true,
      client: mockClient(),
      cursorsPath,
    })
    expect(result.collectionStatus).toBe("completed")
    expect(existsSync(join(agentRoot, "inbox", "pump-scan-3", "pump-fyp.json"))).toBe(true)
    expect(existsSync(join(agentRoot, "inbox", "pump-scan-3", "pump-fyp-eligible.json"))).toBe(true)
    const layout = await ensureArchive(archiveRoot)
    expect(existsSync(join(layout.outcomes, "pump-call-pump-scan-3.json"))).toBe(true)
    const queue = new StateStore(join(agentRoot, "state")).loadResearchQueue()
    expect(queue.entries).toHaveLength(0)
  })

  it("scrapes Following at 10 follows and omits leaderboard addresses", async () => {
    const root = mkdtempSync(join(tmpdir(), "pump-follow-"))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    mkdirSync(join(agentRoot, "inbox"), { recursive: true })
    mkdirSync(join(agentRoot, "state"), { recursive: true })
    const state = new StateStore(join(agentRoot, "state"))
    await state.savePumpEngagement({
      schema: 1,
      followedHandles: Array.from({ length: 10 }, (_, i) => `user${i}`),
      likedItemIds: [],
      lastLikedAt: {},
      lastFollowedAt: {},
      pendingActionIds: [],
      decisions: [],
      receipts: [],
      daily: { day: "2026-08-13", likes: 0, follows: 0, unfollows: 0 },
    })
    await savePumpGates(archiveRoot, passGates())
    const writer = new SnapshotWriter(agentRoot)
    const result = await collectPumpScan({
      runId: "pump-scan-4",
      writer,
      fetchedAt: NOW,
      agentRoot,
      archiveRoot,
      config: pumpConfig({ enabled: true, shadow_mode: true }),
      sessionExists: true,
      client: mockClient({ following: [item("following", "coin-follow", "followed-author")] }),
      cursorsPath: join(root, "cursors.json"),
    })
    expect(result.collectionStatus).toBe("completed")
    expect(existsSync(join(agentRoot, "inbox", "pump-scan-4", "pump-following.json"))).toBe(true)
    const board = JSON.parse(
      readFileSync(join(agentRoot, "inbox", "pump-scan-4", "pump-leaderboard.json"), "utf8"),
    ) as { items: ReadonlyArray<{ text: string }> }
    expect(board.items[0]?.text).toBe("handle=lb-alpha rank=1")
    expect(JSON.stringify(board)).not.toMatch(/address|wallet/iu)
  })
})
