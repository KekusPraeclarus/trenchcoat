import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  completeAttempt,
  emptyUsageDay,
  loadUsageDay,
  remainingBudget,
  reserveAttempt,
  saveUsageDay,
} from "../../src/collectors/twitter/fomo-source-review-usage.js"

describe("fomo x source review usage ledger", () => {
  it("reserves before navigation and recovers after crash-complete", async () => {
    const root = mkdtempSync(join(tmpdir(), "fomo-x-usage-"))
    let day = emptyUsageDay("2026-07-19", 20)
    const reserved = reserveAttempt(day, {
      requestId: "page-1",
      endpointFamily: "profile-history",
      at: "2026-07-19T00:00:00.000Z",
    })
    day = reserved.day
    expect(remainingBudget(day)).toBe(19)
    await saveUsageDay(root, day)

    day = loadUsageDay(root, "2026-07-19", 20)
    expect(day.reserved).toBe(1)
    day = completeAttempt(day, {
      attemptId: reserved.attemptId,
      ok: true,
      counted: true,
      at: "2026-07-19T00:01:00.000Z",
    })
    await saveUsageDay(root, day)
    expect(loadUsageDay(root, "2026-07-19", 20).completedCounted).toBe(1)
  })

  it("exhausts the shared 20-page budget", () => {
    let day = emptyUsageDay("2026-07-19", 20)
    for (let i = 0; i < 20; i += 1) {
      const next = reserveAttempt(day, {
        requestId: `p${i}`,
        endpointFamily: "profile-history",
        at: "2026-07-19T00:00:00.000Z",
      })
      day = next.day
    }
    expect(remainingBudget(day)).toBe(0)
    expect(() => reserveAttempt(day, {
      requestId: "overflow",
      endpointFamily: "profile-history",
      at: "2026-07-19T00:00:00.000Z",
    })).toThrow(/budget/i)
  })
})
