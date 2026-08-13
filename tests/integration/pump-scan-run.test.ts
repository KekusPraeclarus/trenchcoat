import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SnapshotWriter } from "../../src/lib/snapshot.js"
import { ConfigSchema, type TrenchcoatConfig } from "../../src/lib/config.js"
import { collectPumpScan } from "../../src/orchestrator/pump-collect.js"
import { processPumpScanEngagement } from "../../src/orchestrator/pump-engagement.js"
import { savePumpGates } from "../../src/collectors/pump/gates.js"
import { ensureArchive } from "../../src/lib/archive.js"
import type { PumpDataSource, PumpFeedItem, PumpGatesFile } from "../../src/collectors/pump/types.js"

const MINT = "EN2nnxrg8uUi6x2sJkzNPd2eT6rB9rdSoQNNaENA4RZA"
const NOW = "2026-08-13T12:00:00.000Z"
const RUN = "pump-scan-run-1"
const seed = JSON.parse(
  readFileSync(join(process.cwd(), "config/seed.example.json"), "utf8"),
) as Record<string, unknown>

function pumpConfig(): TrenchcoatConfig {
  const base = ConfigSchema.parse(seed)
  return {
    ...base,
    pump: {
      ...base.pump,
      enabled: true,
      shadow_mode: true,
      engagement: { ...base.pump.engagement, enabled: true },
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

function item(tab: PumpFeedItem["tab"]): PumpFeedItem {
  return { itemId: `coin-${tab}`, author: `${tab}-author`, tab, mint: MINT, chain: "solana", observedAt: NOW }
}

function mockClient(): PumpDataSource {
  return {
    readFeed: async ({ tab }) => [item(tab)],
    readLeaderboard: async () => [{ handle: "lb-alpha", rank: 1, observedAt: NOW }],
    readCallerProfile: async (handle) => ({
      handle,
      calls: [{ callerId: handle, chain: "solana", tokenAddress: MINT, calledAt: NOW }],
    }),
    close: async () => undefined,
  }
}

describe("pump-scan run (injected collect)", () => {
  it("writes inbox, archives calls, and skips mutations in shadow", async () => {
    const root = mkdtempSync(join(tmpdir(), "pump-scan-run-"))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    mkdirSync(join(agentRoot, "inbox"), { recursive: true })
    mkdirSync(join(agentRoot, "state"), { recursive: true })
    mkdirSync(join(agentRoot, "reports", RUN), { recursive: true })
    await savePumpGates(archiveRoot, passGates())
    const writer = new SnapshotWriter(agentRoot)
    const collect = await collectPumpScan({
      runId: RUN,
      writer,
      fetchedAt: NOW,
      agentRoot,
      archiveRoot,
      config: pumpConfig(),
      sessionExists: true,
      client: mockClient(),
      cursorsPath: join(root, "cursors.json"),
    })
    expect(collect.skipAgent).toBe(false)
    const layout = await ensureArchive(archiveRoot)
    expect(existsSync(join(layout.outcomes, `pump-call-${RUN}.json`))).toBe(true)
    writeFileSync(join(agentRoot, "reports", RUN, "pump-engagement.json"), `${JSON.stringify({
      schema: 1,
      runId: RUN,
      proposedAt: NOW,
      items: [{
        action: "like",
        itemId: "coin-fyp",
        authorHandle: "fyp-author",
        reasonCode: "chart-quality",
        rationale: "chart",
      }],
    }, null, 2)}\n`)
    const engagement = await processPumpScanEngagement({
      agentRoot,
      archiveRoot,
      runId: RUN,
      nowIso: NOW,
      config: pumpConfig(),
    })
    expect(engagement.executed).toBe(0)
    expect(engagement.shadowMode).toBe(true)
  })
})
