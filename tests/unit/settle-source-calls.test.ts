import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { archiveLayout } from "../../src/lib/archive.js"
import {
  appendSourceCallEventsFromArchiveInbox,
  readSourceCallLog,
  sourceCallLogPath,
} from "../../src/orchestrator/call-log.js"
import { runSettleSourceCalls } from "../../src/orchestrator/settle-source-calls.js"
import { readOutcomeObservation } from "../../src/orchestrator/scorecard.js"
import type { PriceBar } from "../../src/orchestrator/observations.js"

const TOKEN = "So11111111111111111111111111111111111111112"
const MENTION = "2026-07-01T00:00:00.000Z"
const NOW = "2026-07-20T00:00:00.000Z"

function seedInbox(root: string, runId: string): void {
  const inbox = join(root, "runs", runId, "inbox")
  mkdirSync(inbox, { recursive: true })
  writeFileSync(join(inbox, "twitter.json"), `${JSON.stringify({
    source: "twitter",
    fetchedAt: MENTION,
    trust: "untrusted-external",
    items: [{
      provenance: "twitter:@caller",
      text: `buy ${TOKEN} now, sending it`,
      ts: MENTION,
      ageSec: 0,
      freshnessTier: "live",
    }],
  }, null, 2)}\n`)
}

describe("appendSourceCallEventsFromArchiveInbox", () => {
  it("derives call events from the archive inbox and is idempotent", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-src-log-"))
    const layout = archiveLayout(root)
    seedInbox(root, "run-1")

    const first = await appendSourceCallEventsFromArchiveInbox(layout, "run-1")
    expect(first.appended).toBe(1)
    expect(existsSync(sourceCallLogPath(layout))).toBe(true)

    const again = await appendSourceCallEventsFromArchiveInbox(layout, "run-1")
    expect(again.appended).toBe(0)
    expect(again.skipped).toBe(1)

    const events = readSourceCallLog(layout)
    expect(events).toHaveLength(1)
    expect(events[0]?.sourceId).toBe("twitter.caller") // colon-free, '@' stripped
    expect(events[0]?.provenance).toBe("twitter:@caller")
    expect(events[0]?.rawAddress).toBe(TOKEN)
  })
})

describe("runSettleSourceCalls", () => {
  it("prices mature calls into outcome observations and skips complete ones on re-run", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-src-settle-"))
    const layout = archiveLayout(root)
    seedInbox(root, "run-1")
    await appendSourceCallEventsFromArchiveInbox(layout, "run-1")

    const bars: PriceBar[] = [
      { ts: "2026-07-01T00:05:00.000Z", open: 10, finalized: true },
      { ts: "2026-07-04T00:05:00.000Z", open: 25, finalized: true }, // >= +72h
    ]
    const loadBars = (): PriceBar[] => bars

    const report = await runSettleSourceCalls({
      layout,
      nowIso: NOW,
      horizons: [72],
      loadBars,
    })
    expect(report.scanned).toBe(1)
    expect(report.written).toBe(1)
    expect(report.complete).toBe(1)

    const events = readSourceCallLog(layout)
    const subjectId = `${events[0]!.sourceId}:${events[0]!.rawAddress}`
    const obs = readOutcomeObservation(layout, "source-call", subjectId, 72)
    expect(obs?.status).toBe("complete")
    expect(obs?.rawReturn).toBeCloseTo(1.5)

    const rerun = await runSettleSourceCalls({ layout, nowIso: NOW, horizons: [72], loadBars })
    expect(rerun.skipped).toBe(1)
    expect(rerun.written).toBe(0)
  })

  it("leaves immature calls unsettled", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-src-immature-"))
    const layout = archiveLayout(root)
    seedInbox(root, "run-1")
    await appendSourceCallEventsFromArchiveInbox(layout, "run-1")

    // one minute after mention: nothing is mature at any horizon
    const report = await runSettleSourceCalls({
      layout,
      nowIso: "2026-07-01T00:01:00.000Z",
      horizons: [24, 72, 168],
    })
    expect(report.scanned).toBe(0)
    expect(report.written).toBe(0)
    expect(readFileSync(sourceCallLogPath(layout), "utf8").trim().length).toBeGreaterThan(0)
  })
})
