import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { archiveLayout } from "../../src/lib/archive.js"
import { appendSourceCallEventsFromArchiveInbox } from "../../src/orchestrator/call-log.js"
import { runOutcomesSettle } from "../../src/orchestrator/outcomes-settle.js"
import type { PriceBar } from "../../src/orchestrator/observations.js"

const TOKEN = "So11111111111111111111111111111111111111112"
const OLD = "2026-07-01T00:00:00.000Z"
const NOW = "2026-07-20T00:00:00.000Z"

const bars: PriceBar[] = [
  { ts: "2026-07-01T00:05:00.000Z", open: 10, finalized: true },
  { ts: "2026-07-04T00:05:00.000Z", open: 20, finalized: true }, // >= +72h
]

describe("runOutcomesSettle", () => {
  it("drives both settlers and returns per-domain counts", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-settle-all-"))
    const layout = archiveLayout(root)

    const inbox = join(root, "runs", "run-1", "inbox")
    mkdirSync(inbox, { recursive: true })
    writeFileSync(join(inbox, "tg.json"), `${JSON.stringify({
      source: "telegram",
      fetchedAt: OLD,
      trust: "untrusted-external",
      items: [{
        provenance: "telegram:alpha",
        text: `ape ${TOKEN} entry now`,
        ts: OLD,
        ageSec: 0,
        freshnessTier: "live",
      }],
    }, null, 2)}\n`)
    await appendSourceCallEventsFromArchiveInbox(layout, "run-1")

    mkdirSync(layout.outcomes, { recursive: true })
    writeFileSync(join(layout.outcomes, "wallet-buy-run-1.json"), `${JSON.stringify({
      schema: 1,
      runId: "run-1",
      outcomes: [{
        schema: 1,
        eventId: "wb_ok",
        walletId: "solana:w1",
        chain: "solana",
        tokenAddress: TOKEN,
        boughtAt: OLD,
        finalized: true,
        removed: false,
        priceable: true,
        rug: false,
      }],
    }, null, 2)}\n`)

    const report = await runOutcomesSettle({
      layout,
      nowIso: NOW,
      horizons: [72],
      sourceBars: () => bars,
      walletBars: () => bars,
    })

    expect(report.sourceCalls.complete).toBe(1)
    expect(report.sourcePeaks.written).toBeGreaterThanOrEqual(1)
    expect(report.walletBuys.complete).toBe(1)
    expect(report.walletBuys.buysUpdated).toBe(1)
    expect(report.walletCopyTrades).toBeDefined()
    expect(report.fomoCopyTrades).toBeDefined()
  })
})
