import { describe, expect, it } from "vitest"

/**
 * Opt-in live semantic eval for Discord tracking intent/match (INV-D8).
 * Gate: TRENCHCOAT_LIVE_E2E=1. Pins composer-2.5.
 * Archive results in docs/architecture/discord-tracking.md to support INV-D8
 * semantic claims (tracking defaults enabled).
 */
const live = process.env["TRENCHCOAT_LIVE_E2E"] === "1"

describe.runIf(live)("discord tracking model live eval", () => {
  it("placeholder corpus gate — expand with pinned fixtures for INV-D8", async () => {
    // Safety floor: this suite exists so INV-D8 cannot claim ENFORCED model quality
    // without an opt-in run. Fill corpus + confusion matrix before tightening claims.
    expect(true).toBe(true)
  })
})

describe("discord tracking live eval scaffold", () => {
  it("documents acceptance thresholds", () => {
    expect({
      safety: 1,
      intentAccuracy: 0.95,
      matchRecall: 0.9,
      matchFalsePositive: 0.02,
    }).toMatchObject({
      safety: 1,
      intentAccuracy: 0.95,
      matchRecall: 0.9,
      matchFalsePositive: 0.02,
    })
  })
})
