import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureArchive } from "../../src/lib/archive.js"
import { loadBroadcastLedger, reserveBroadcast } from "../../src/orchestrator/broadcast-ledger.js"

const DAY = "2026-07-17"
const NOW = "2026-07-17T12:00:00.000Z"

async function layout() {
  return ensureArchive(mkdtempSync(join(tmpdir(), "tc-ledger-")))
}

describe("broadcast budget ledger", () => {
  it("is idempotent by reservation key", async () => {
    const l = await layout()
    const first = await reserveBroadcast({
      layout: l, dayKey: DAY, reservationKey: "k1", severity: "watch",
      dailyBudget: 5, urgentCeiling: 10, nowIso: NOW,
    })
    const again = await reserveBroadcast({
      layout: l, dayKey: DAY, reservationKey: "k1", severity: "watch",
      dailyBudget: 5, urgentCeiling: 10, nowIso: NOW,
    })
    expect(first.ok).toBe(true)
    expect(again.ok).toBe(true)
    expect(loadBroadcastLedger(l, DAY).used).toBe(1)
  })

  it("rejects once the daily budget is spent", async () => {
    const l = await layout()
    const ok = await reserveBroadcast({
      layout: l, dayKey: DAY, reservationKey: "k1", severity: "notable",
      dailyBudget: 1, urgentCeiling: 10, nowIso: NOW,
    })
    const over = await reserveBroadcast({
      layout: l, dayKey: DAY, reservationKey: "k2", severity: "notable",
      dailyBudget: 1, urgentCeiling: 10, nowIso: NOW,
    })
    expect(ok.ok).toBe(true)
    expect(over.ok).toBe(false)
    expect(over.reason).toBe("daily-budget")
    expect(loadBroadcastLedger(l, DAY).used).toBe(1)
  })

  it("tracks urgent against its own ceiling", async () => {
    const l = await layout()
    const ok = await reserveBroadcast({
      layout: l, dayKey: DAY, reservationKey: "u1", severity: "urgent",
      dailyBudget: 5, urgentCeiling: 1, nowIso: NOW,
    })
    const over = await reserveBroadcast({
      layout: l, dayKey: DAY, reservationKey: "u2", severity: "urgent",
      dailyBudget: 5, urgentCeiling: 1, nowIso: NOW,
    })
    expect(ok.ok).toBe(true)
    expect(over.ok).toBe(false)
    expect(over.reason).toBe("urgent-ceiling")
    const ledger = loadBroadcastLedger(l, DAY)
    expect(ledger.urgentUsed).toBe(1)
    expect(ledger.used).toBe(0)
  })
})
