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
} from "../../src/collectors/pump/usage.js"

describe("pump usage crash resume", () => {
  it("reserved attempt survives process restart without double-raising budget", async () => {
    const root = mkdtempSync(join(tmpdir(), "pump-crash-usage-"))
    const reserved = reserveAttempt(emptyUsageDay("2026-08-13", 10), {
      requestId: "req-1",
      endpointFamily: "feed",
      at: "2026-08-13T00:00:00.000Z",
    })
    await saveUsageDay(root, reserved.day)
    const reloaded = loadUsageDay(root, "2026-08-13", 10)
    expect(reloaded.reserved).toBe(1)
    const finished = completeAttempt(reloaded, {
      attemptId: reserved.attemptId,
      ok: true,
      counted: true,
      at: "2026-08-13T00:00:01.000Z",
    })
    await saveUsageDay(root, finished)
    const again = loadUsageDay(root, "2026-08-13", 10)
    expect(again.reserved).toBe(1)
    expect(again.completedCounted).toBe(1)
  })

  it("uses the caller budget so a smoke cap cannot pin the collect day", async () => {
    const root = mkdtempSync(join(tmpdir(), "pump-usage-budget-"))
    await saveUsageDay(root, emptyUsageDay("2026-08-17", 40))
    const loaded = loadUsageDay(root, "2026-08-17", 200)
    expect(loaded.budget).toBe(200)
    expect(loaded.reserved).toBe(0)
  })
})
