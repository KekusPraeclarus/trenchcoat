import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  advancePumpScanCursor,
  loadPumpScanCursors,
  pumpScanCursorsPath,
} from "../../src/orchestrator/pump-scan-cursors.js"

describe("pump-scan cursors", () => {
  it("keeps cursors under the trenchcoat home, never agent/", () => {
    const home = join("/tmp", "trenchcoat-home")
    expect(pumpScanCursorsPath(home)).toBe(join(home, "pump-scan", "cursors.json"))
    expect(pumpScanCursorsPath(home)).not.toMatch(/\/agent\//u)
  })

  it("advances a tab cursor and reloads it", async () => {
    const root = mkdtempSync(join(tmpdir(), "pump-cursors-"))
    const path = join(root, "cursors.json")
    await advancePumpScanCursor({
      cursorsPath: path,
      tab: "fyp",
      lastItemId: "coin-1",
      nowIso: "2026-08-13T12:00:00.000Z",
    })
    const loaded = loadPumpScanCursors(path)
    expect(loaded.tabs["fyp"]?.lastItemId).toBe("coin-1")
  })
})
