import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assertTwitterSessionReady } from "../../src/collectors/twitter/scrape.js"
import {
  assertXSessionNotHeld,
  clearXSessionHold,
  loadXSessionHold,
  saveXSessionHold,
  XSessionHeldError,
  xSessionHoldPath,
} from "../../src/collectors/twitter/session-hold.js"

describe("x session hold", () => {
  it("round-trips a challenge hold and clears it", async () => {
    const home = mkdtempSync(join(tmpdir(), "tc-hold-"))
    const path = xSessionHoldPath(home)
    expect(loadXSessionHold(path)).toBeUndefined()
    await saveXSessionHold({
      path,
      heldAt: "2026-08-28T13:37:06.707Z",
      target: "operator-list-1",
    })
    const hold = loadXSessionHold(path)
    expect(hold).toMatchObject({
      schema: 1,
      reason: "challenge",
      heldAt: "2026-08-28T13:37:06.707Z",
      target: "operator-list-1",
      clearWith: "tc auth twitter",
    })
    expect(clearXSessionHold(path)).toBe(true)
    expect(loadXSessionHold(path)).toBeUndefined()
    expect(clearXSessionHold(path)).toBe(false)
  })

  it("refuses scrapes while held", async () => {
    const home = mkdtempSync(join(tmpdir(), "tc-hold-ready-"))
    await saveXSessionHold({
      path: xSessionHoldPath(home),
      heldAt: "2026-08-28T13:37:06.707Z",
    })
    expect(() => assertXSessionNotHeld(home)).toThrow(XSessionHeldError)
    expect(() => assertTwitterSessionReady(home)).toThrow(XSessionHeldError)
  })
})
