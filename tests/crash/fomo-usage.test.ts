import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  completeAttempt,
  emptyUsageDay,
  loadUsageDay,
  reserveAttempt,
  saveUsageDay,
} from "../../src/collectors/fomo/usage.js"

describe("fomo usage crash resume", () => {
  it("reserved attempt survives process restart without double-raising budget", async () => {
    const root = mkdtempSync(join(tmpdir(), "fomo-crash-"))
    let day = emptyUsageDay("2026-07-18", 10)
    const reserved = reserveAttempt(day, {
      requestId: "req-1",
      endpointFamily: "activity",
      at: "2026-07-18T00:00:00.000Z",
    })
    await saveUsageDay(root, reserved.day)

    const reloaded = loadUsageDay(root, "2026-07-18", 10)
    expect(reloaded.reserved).toBe(1)
    const finished = completeAttempt(reloaded, {
      attemptId: reserved.attemptId,
      ok: true,
      counted: true,
      at: "2026-07-18T00:00:01.000Z",
    })
    await saveUsageDay(root, finished)
    const again = loadUsageDay(root, "2026-07-18", 10)
    expect(again.reserved).toBe(1)
    expect(again.completedCounted).toBe(1)
    expect(join(root, "provider-usage", "fomo", "2026-07-18.json")).toMatch(/provider-usage\/fomo\//u)
  })
})
