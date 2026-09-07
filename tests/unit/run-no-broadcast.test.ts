import { describe, expect, it } from "vitest"
import { runSuppressesBroadcast } from "../../src/orchestrator/run.js"

describe("runSuppressesBroadcast", () => {
  it("stays open when neither gate is set", () => {
    expect(runSuppressesBroadcast({ blockExternalEffects: false })).toBe(false)
  })

  it("suppresses canary egress and operator memory-only runs", () => {
    expect(runSuppressesBroadcast({ blockExternalEffects: true })).toBe(true)
    expect(runSuppressesBroadcast({ blockExternalEffects: false, noBroadcast: true })).toBe(true)
    expect(runSuppressesBroadcast({ blockExternalEffects: true, noBroadcast: true })).toBe(true)
  })
})
