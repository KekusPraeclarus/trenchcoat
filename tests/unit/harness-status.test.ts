import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  assessHarnessImproveReadiness,
  harnessStatusSnapshot,
  loadHarnessScheduleReport,
} from "../../src/harness/readiness.js"
import { persistHarnessScheduleReport } from "../../src/harness/schedule.js"

describe("harness status snapshot", () => {
  it("includes lastRun from global schedule report", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-hstatus-"))
    const archiveRoot = join(root, "archive")
    mkdirSync(archiveRoot, { recursive: true })
    await persistHarnessScheduleReport(
      archiveRoot,
      {
        status: "skipped",
        reason: "require_two_epochs: need distinct development and holdout sealed epochs",
        reasonSlug: "distinct-epochs",
        nextAction: "wait for a second distinct sealed audit epoch",
        developmentEpochId: "audit-a",
        holdoutEpochId: "audit-a",
      },
      "2026-08-04T19:35:29.000Z",
    )

    const last = loadHarnessScheduleReport(archiveRoot)
    expect(last?.reasonSlug).toBe("distinct-epochs")

    const snap = harnessStatusSnapshot({
      archiveRoot,
      config: {
        enabled: true,
        schedule_enabled: true,
        require_two_epochs: true,
        one_active_experiment: true,
        min_events: 40,
        min_holdout_events: 20,
      },
    })
    expect(snap.lastRun?.reasonSlug).toBe("distinct-epochs")
    expect(snap.readiness.ready).toBe(false)
    expect(snap.nextAction).toMatch(/second distinct|sealed/u)

    // readiness remains read-only even after lastRun exists
    const before = JSON.stringify(snap.readiness.gates)
    assessHarnessImproveReadiness({
      archiveRoot,
      config: {
        enabled: true,
        schedule_enabled: true,
        require_two_epochs: true,
        one_active_experiment: true,
        min_events: 40,
        min_holdout_events: 20,
      },
    })
    expect(JSON.stringify(
      harnessStatusSnapshot({
        archiveRoot,
        config: {
          enabled: true,
          schedule_enabled: true,
          require_two_epochs: true,
          one_active_experiment: true,
          min_events: 40,
          min_holdout_events: 20,
        },
      }).readiness.gates,
    )).toBe(before)

    writeFileSync(join(root, "marker"), "ok\n")
  })
})
