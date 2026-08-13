import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SnapshotWriter } from "../../src/lib/snapshot.js"
import { ConfigSchema, type TrenchcoatConfig } from "../../src/lib/config.js"
import { collectPumpScan } from "../../src/orchestrator/pump-collect.js"
import { savePumpGates } from "../../src/collectors/pump/gates.js"
import type { PumpDataSource, PumpGatesFile } from "../../src/collectors/pump/types.js"

const NOW = "2026-08-13T12:00:00.000Z"
const seed = JSON.parse(
  readFileSync(join(process.cwd(), "config/seed.example.json"), "utf8"),
) as Record<string, unknown>

function pumpConfig(): TrenchcoatConfig {
  const base = ConfigSchema.parse(seed)
  return { ...base, pump: { ...base.pump, enabled: true, shadow_mode: true } }
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

function emptyClient(): PumpDataSource {
  return {
    readFeed: async () => [],
    readLeaderboard: async () => [],
    readCallerProfile: async (handle) => ({ handle, calls: [] }),
    close: async () => undefined,
  }
}

describe("pump-scan collect skip statuses", () => {
  it("records following-skipped-below-min when follows are under 10", async () => {
    const root = mkdtempSync(join(tmpdir(), "pump-skip-follow-"))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    mkdirSync(join(agentRoot, "inbox"), { recursive: true })
    mkdirSync(join(agentRoot, "state"), { recursive: true })
    await savePumpGates(archiveRoot, passGates())
    const result = await collectPumpScan({
      runId: "pump-scan-skip-1",
      writer: new SnapshotWriter(agentRoot),
      fetchedAt: NOW,
      agentRoot,
      archiveRoot,
      config: pumpConfig(),
      sessionExists: true,
      client: emptyClient(),
      cursorsPath: join(root, "cursors.json"),
    })
    expect(result.collectionStatus).toBe("completed")
    const status = JSON.parse(
      readFileSync(join(agentRoot, "inbox", "pump-scan-skip-1", "pump-scan-collection-status.json"), "utf8"),
    ) as { items: ReadonlyArray<{ text: string }> }
    expect(status.items[0]?.text).toMatch(/following-skipped-below-min/u)
  })
})
