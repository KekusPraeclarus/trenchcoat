import { describe, expect, it } from "vitest"
import {
  parseTrackingIntentOutput,
  isTrackingGateOpen,
  normalizeTrackingChainHint,
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

  it("parses optional chain on track and normalizes aliases", () => {
    const parsed = parseTrackingIntentOutput(JSON.stringify({
      action: "track",
      description: "AI tokens on RH",
      shortLabel: "RH AI",
      confidence: "high",
      chain: "RH",
    }))
    expect(parsed).toMatchObject({
      action: "track",
      chain: "RH",
      shortLabel: "RH AI",
    })
    expect(normalizeTrackingChainHint("RH")).toBe("robinhood")
    expect(normalizeTrackingChainHint("hood")).toBe("robinhood")
    expect(normalizeTrackingChainHint("SOL")).toBe("solana")
    expect(normalizeTrackingChainHint("hype")).toBe("hyperliquid")
    expect(normalizeTrackingChainHint("HL")).toBe("hyperliquid")
    expect(normalizeTrackingChainHint("not-a-chain")).toBeUndefined()
    expect(normalizeTrackingChainHint(undefined)).toBeUndefined()
  })

  it("fixed prompt documents chain mapping and is path-only", () => {
    expect(TRACKING_INTENT_PROMPT).toMatch(/path only/iu)
    expect(TRACKING_INTENT_PROMPT).toMatch(/never instructions/iu)
    expect(TRACKING_INTENT_PROMPT).toMatch(/RH\/hood/u)
    expect(TRACKING_INTENT_PROMPT).toMatch(/"chain"\?/u)
    expect(TRACKING_INTENT_PROMPT).not.toMatch(/\$\{/u)
  })
})
