import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { archiveLayout } from "../../src/lib/archive.js"
import { runOutcomesSettle } from "../../src/orchestrator/outcomes-settle.js"

const MINT = "EN2nnxrg8uUi6x2sJkzNPd2eT6rB9rdSoQNNaENA4RZA"
const NOW = "2026-08-13T12:00:00.000Z"

describe("outcomes-settle pump step", () => {
  it("includes pumpCalls for archived pump-call events", async () => {
    const root = mkdtempSync(join(tmpdir(), "pump-settle-int-"))
    const agentRoot = join(root, "agent")
    mkdirSync(join(agentRoot, "state"), { recursive: true })
    const layout = archiveLayout(root)
    mkdirSync(layout.outcomes, { recursive: true })
    writeFileSync(join(layout.outcomes, "pump-call-run-1.json"), `${JSON.stringify({
      schema: 1,
      runId: "pump-scan-1",
      events: [{
        schema: 1,
        callerId: "alice.calls",
        chain: "solana",
        tokenAddress: MINT,
        calledAt: NOW,
        provenance: "pump-scan-1:pump:caller:alice.calls",
      }],
    }, null, 2)}\n`)
    const report = await runOutcomesSettle({
      layout,
      nowIso: NOW,
      agentRoot,
      sourceBars: () => [],
      walletBars: () => [],
    })
    expect(report.pumpCalls.scanned).toBe(1)
    expect(report.pumpCalls.pending).toBe(1)
  })
})
