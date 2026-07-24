import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureArchive } from "../../src/lib/archive.js"
import { runSettleDecisions } from "../../src/orchestrator/settle-decisions.js"
import { readOutcomeObservation } from "../../src/orchestrator/scorecard.js"
import { makeDecisionBundle } from "../helpers/harness-archive.js"
import { writeDecisionBundle } from "../../src/orchestrator/scorecard.js"

describe("settle-decisions", () => {
  it("writes censored outcome when identity missing and is resumable", async () => {
    const archiveRoot = mkdtempSync(join(tmpdir(), "settle-dec-"))
    const layout = await ensureArchive(archiveRoot)
    const bundle = makeDecisionBundle({
      decisionId: "dec-no-id",
      withIdentity: false,
    })
    await writeDecisionBundle(layout, bundle)

    const first = await runSettleDecisions({
      layout,
      nowIso: "2026-07-20T00:00:00.000Z",
      horizons: [72],
      settlementHours: 0,
    })
    expect(first.censored).toBeGreaterThanOrEqual(1)
    const obs = readOutcomeObservation(layout, "decision", "dec-no-id", 72)
    expect(obs?.status).toBe("censored")

    const second = await runSettleDecisions({
      layout,
      nowIso: "2026-07-20T00:00:00.000Z",
      horizons: [72],
      settlementHours: 0,
    })
    expect(second.skipped).toBeGreaterThanOrEqual(1)
  })

  it("materializes complete outcome from injectable bars", async () => {
    const archiveRoot = mkdtempSync(join(tmpdir(), "settle-dec2-"))
    const layout = await ensureArchive(archiveRoot)
    const bundle = makeDecisionBundle({ decisionId: "dec-ok" })
    await writeDecisionBundle(layout, bundle)

    const report = await runSettleDecisions({
      layout,
      nowIso: "2026-07-20T00:00:00.000Z",
      horizons: [72],
      settlementHours: 0,
      loadBars: async () => [
        { ts: "2026-07-10T00:05:00.000Z", open: 1, finalized: true },
        { ts: "2026-07-13T00:05:00.000Z", open: 1.3, finalized: true },
      ],
    })
    expect(report.complete).toBe(1)
    const obs = readOutcomeObservation(layout, "decision", "dec-ok", 72)
    expect(obs?.status).toBe("complete")
    expect(obs?.excessReturn).toBeGreaterThan(0)
  })
})
