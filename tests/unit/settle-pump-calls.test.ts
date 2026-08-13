import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { archiveLayout } from "../../src/lib/archive.js"
import { StateStore } from "../../src/lib/state.js"
import { runSettlePumpCalls } from "../../src/orchestrator/settle-pump-calls.js"
import { readOutcomeObservation } from "../../src/orchestrator/scorecard.js"
import { PEAK_HORIZON_HOURS, type PriceBar } from "../../src/orchestrator/observations.js"
import type { PumpCallEvent } from "../../src/contracts/schemas.js"

const MINT = "EN2nnxrg8uUi6x2sJkzNPd2eT6rB9rdSoQNNaENA4RZA"
const CALLED = "2026-08-12T12:00:00.000Z"
const NOW = "2026-08-13T12:00:00.000Z"

function subjectId(calledAt: string): string {
  const digest = createHash("sha256")
    .update(`alice.calls|solana|${MINT}|${calledAt}`)
    .digest("hex")
    .slice(0, 40)
  return `pc-${digest}`
}

function event(calledAt: string): PumpCallEvent {
  return {
    schema: 1,
    callerId: "alice.calls",
    chain: "solana",
    tokenAddress: MINT,
    calledAt,
    provenance: "pump-scan-1:pump:caller:alice.calls",
  }
}

function writeCall(root: string, calledAt = CALLED): void {
  const layout = archiveLayout(root)
  mkdirSync(layout.outcomes, { recursive: true })
  writeFileSync(join(layout.outcomes, "pump-call-run-1.json"), `${JSON.stringify({
    schema: 1,
    runId: "pump-scan-1",
    events: [event(calledAt)],
  }, null, 2)}\n`)
}

describe("settle pump calls", () => {
  it("keeps calls younger than 24h as min-age pending", async () => {
    const root = mkdtempSync(join(tmpdir(), "pump-settle-age-"))
    const calledAt = "2026-08-13T06:00:00.000Z"
    writeCall(root, calledAt)
    const layout = archiveLayout(root)
    const report = await runSettlePumpCalls({
      layout,
      nowIso: NOW,
      minAgeHours: 24,
      fetchSecurity: async () => ({ status: "pass", hardFail: false, flags: [] }),
      loadBars: () => [],
    })
    expect(report.pending).toBe(1)
    const obs = readOutcomeObservation(layout, "pump-call", subjectId(calledAt), PEAK_HORIZON_HOURS)
    expect(obs?.status).toBe("provider-pending")
    expect(obs?.exclusionReason).toBe("min-age")
  })

  it("writes terminal-loss on security hardFail and does not complete as a hit", async () => {
    const root = mkdtempSync(join(tmpdir(), "pump-settle-rug-"))
    const agentRoot = join(root, "agent")
    mkdirSync(join(agentRoot, "state"), { recursive: true })
    writeCall(root)
    const layout = archiveLayout(root)
    const report = await runSettlePumpCalls({
      layout,
      nowIso: NOW,
      agentRoot,
      minAgeHours: 24,
      fetchSecurity: async () => ({ status: "hard-fail", hardFail: true, flags: [] }),
      loadBars: () => [{ ts: "2026-08-12T13:00:00.000Z", open: 10, high: 20, finalized: true }],
    })
    expect(report.terminalLoss).toBe(1)
    expect(report.complete).toBe(0)
    const obs = readOutcomeObservation(layout, "pump-call", subjectId(CALLED), PEAK_HORIZON_HOURS)
    expect(obs?.status).toBe("terminal-loss")
    expect(obs?.exclusionReason).toBe("rugged-after-call")
    const scores = new StateStore(join(agentRoot, "state")).loadPumpCallerScores()
    expect(scores.callers[0]?.hits).toBe(0)
    expect(scores.callers[0]?.rugExposure).toBe(1)
  })

  it("completes a +20% peak after the quiet window", async () => {
    const root = mkdtempSync(join(tmpdir(), "pump-settle-hit-"))
    const agentRoot = join(root, "agent")
    mkdirSync(join(agentRoot, "state"), { recursive: true })
    writeCall(root)
    const layout = archiveLayout(root)
    const bars: PriceBar[] = [
      { ts: "2026-08-12T12:05:00.000Z", open: 10, high: 10, finalized: true },
      { ts: "2026-08-12T18:05:00.000Z", open: 12, high: 13, finalized: true },
    ]
    const report = await runSettlePumpCalls({
      layout,
      nowIso: NOW,
      agentRoot,
      minAgeHours: 24,
      fetchSecurity: async () => ({ status: "pass", hardFail: false, flags: [] }),
      loadBars: () => bars,
    })
    expect(report.complete).toBe(1)
    const scores = new StateStore(join(agentRoot, "state")).loadPumpCallerScores()
    expect(scores.callers[0]?.hits).toBe(1)
  })

  it("keeps provider outages pending", async () => {
    const root = mkdtempSync(join(tmpdir(), "pump-settle-outage-"))
    writeCall(root)
    const layout = archiveLayout(root)
    const report = await runSettlePumpCalls({
      layout,
      nowIso: NOW,
      minAgeHours: 24,
      fetchSecurity: async () => ({ status: "pass", hardFail: false, flags: [] }),
      loadBars: () => [],
    })
    expect(report.pending).toBe(1)
    expect(report.complete).toBe(0)
    const obs = readOutcomeObservation(layout, "pump-call", subjectId(CALLED), PEAK_HORIZON_HOURS)
    expect(obs?.exclusionReason).toBe("missing-bars")
  })
})
