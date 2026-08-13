import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { archiveLayout } from "../../src/lib/archive.js"
import { StateStore } from "../../src/lib/state.js"
import { runSettlePumpCalls } from "../../src/orchestrator/settle-pump-calls.js"
import { PumpCallerScoresFileSchema } from "../../src/contracts/schemas.js"

describe("prop pump origin confinement", () => {
  it("caller scores never carry a chain address field", () => {
    const parsed = PumpCallerScoresFileSchema.parse({
      schema: 1,
      callers: [{
        handle: "alice.calls",
        settledCalls: 2,
        hits: 1,
        hitMean: 0.5,
        medianPeakPct: 0.2,
        rugExposure: 0,
        scoreCutoff: "2026-08-13T12:00:00.000Z",
        updatedAt: "2026-08-13T12:00:00.000Z",
      }],
    })
    expect(JSON.stringify(parsed)).not.toMatch(/address|wallet/iu)
  })

  it("settle never writes wallets.json", async () => {
    const root = mkdtempSync(join(tmpdir(), "pump-origin-"))
    const agentRoot = join(root, "agent")
    mkdirSync(join(agentRoot, "state"), { recursive: true })
    const layout = archiveLayout(root)
    mkdirSync(layout.outcomes, { recursive: true })
    await runSettlePumpCalls({
      layout,
      nowIso: "2026-08-13T12:00:00.000Z",
      agentRoot,
      minAgeHours: 24,
      fetchSecurity: async () => ({ status: "pass", hardFail: false, flags: [] }),
      loadBars: () => [],
    })
    const wallets = new StateStore(join(agentRoot, "state")).loadWallets()
    expect(wallets.wallets).toEqual([])
  })
})
