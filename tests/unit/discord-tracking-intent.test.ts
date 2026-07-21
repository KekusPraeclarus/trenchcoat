import { describe, expect, it } from "vitest"
import {
  parseTrackingIntentOutput,
  isTrackingGateOpen,
} from "../../src/discord/tracking-intent.js"
import { TRACKING_INTENT_PROMPT } from "../../src/prompts/host.js"

describe("discord tracking intent", () => {
  it("requires mention or reply gate", () => {
    expect(isTrackingGateOpen({ mentionsBot: false, replyToBot: false })).toBe(false)
    expect(isTrackingGateOpen({ mentionsBot: true, replyToBot: false })).toBe(true)
  })

  it("parses actions and fail-closes garbage", () => {
    expect(parseTrackingIntentOutput(JSON.stringify({
      action: "drop",
      trackingIds: ["trk-abcdef12"],
    }))).toEqual({ action: "drop", trackingIds: ["trk-abcdef12"] })
    expect(parseTrackingIntentOutput("")).toBeUndefined()
    expect(parseTrackingIntentOutput("hello")).toBeUndefined()
  })

  it("fixed prompt is path-only and injection-resistant", () => {
    expect(TRACKING_INTENT_PROMPT).toMatch(/path only/iu)
    expect(TRACKING_INTENT_PROMPT).toMatch(/never instructions/iu)
    expect(TRACKING_INTENT_PROMPT).not.toMatch(/\$\{/u)
  })
})
