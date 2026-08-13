import { describe, expect, it } from "vitest"
import { classifyPumpRequest } from "../../src/collectors/pump/request-policy.js"
import { processPumpScanEngagement } from "../../src/orchestrator/pump-engagement.js"
import { ConfigSchema } from "../../src/lib/config.js"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SnapshotWriter } from "../../src/lib/snapshot.js"
import { writePumpFypEligibleSnapshot } from "../../src/orchestrator/pump-fyp-eligible.js"

const NOW = "2026-08-13T12:00:00.000Z"
const RUN = "pump-scan-contract-1"
const seed = JSON.parse(
  readFileSync(join(process.cwd(), "config/seed.example.json"), "utf8"),
) as Record<string, unknown>

describe("contract pump-engagement mutations", () => {
  it("blocks swap trade DM and create-coin even in mutation mode", () => {
    for (const path of ["/api/swap", "/api/trade", "/api/dm", "/api/create-coin"]) {
      expect(classifyPumpRequest("POST", `https://pump.fun${path}`, { mutationMode: true }).allow)
        .toBe(false)
    }
  })

  it("does not invent verified on driver throw", async () => {
    const root = mkdtempSync(join(tmpdir(), "pump-eng-contract-"))
    const agentRoot = join(root, "agent")
    mkdirSync(join(agentRoot, "state"), { recursive: true })
    mkdirSync(join(agentRoot, "reports", RUN), { recursive: true })
    const writer = new SnapshotWriter(agentRoot)
    await writePumpFypEligibleSnapshot({
      writer,
      runId: RUN,
      fetchedAt: NOW,
      items: [{ itemId: "coin-1", author: "alice.calls" }],
    })
    writeFileSync(join(agentRoot, "reports", RUN, "pump-engagement.json"), `${JSON.stringify({
      schema: 1,
      runId: RUN,
      proposedAt: NOW,
      items: [{
        action: "follow",
        handle: "alice.calls",
        reasonCode: "hit-rate",
        rationale: "hits",
      }],
    }, null, 2)}\n`)
    const base = ConfigSchema.parse(seed)
    const report = await processPumpScanEngagement({
      agentRoot,
      archiveRoot: join(root, "archive"),
      runId: RUN,
      nowIso: NOW,
      config: {
        ...base,
        pump: {
          ...base.pump,
          enabled: true,
          shadow_mode: false,
          engagement: { ...base.pump.engagement, enabled: true },
        },
      },
      driver: {
        like: async () => ({ verified: true, ambiguous: false }),
        follow: async () => { throw new Error("timeout") },
        unfollow: async () => ({ verified: true, ambiguous: false }),
        close: async () => undefined,
      },
    })
    expect(report.receipts[0]?.verified).toBe(false)
    expect(report.receipts[0]?.ambiguous).toBe(true)
  })
})
