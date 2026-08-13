import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  clearIntegrityHoldForIncident,
  loadIntegrityHold,
  setIntegrityHold,
} from "../../src/remediation/integrity-hold.js"

function hold(incidentId: string) {
  return {
    schema: 1 as const,
    incidentId,
    affectedSources: ["dexscreener"],
    affectedJobs: ["narrative-scan"],
    heldAt: "2026-08-12T10:35:48.946Z",
    reason: "awaiting-post-fix-revalidation",
  }
}

describe("clearIntegrityHoldForIncident", () => {
  it("clears only the matching incident hold", async () => {
    const home = mkdtempSync(join(tmpdir(), "tc-hold-"))
    await setIntegrityHold(hold("rem-f867982409aa"), home)
    expect(loadIntegrityHold(home)?.incidentId).toBe("rem-f867982409aa")

    expect(await clearIntegrityHoldForIncident("rem-otherincident", home)).toBe(false)
    expect(loadIntegrityHold(home)?.incidentId).toBe("rem-f867982409aa")

    expect(await clearIntegrityHoldForIncident("rem-f867982409aa", home)).toBe(true)
    expect(loadIntegrityHold(home)).toBeUndefined()
  })

  it("is a no-op when no hold file exists", async () => {
    const home = mkdtempSync(join(tmpdir(), "tc-hold-empty-"))
    expect(await clearIntegrityHoldForIncident("rem-f867982409aa", home)).toBe(false)
  })
})
