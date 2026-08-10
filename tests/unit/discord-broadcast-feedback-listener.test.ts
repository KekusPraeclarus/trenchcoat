import { describe, expect, it } from "vitest"
import { gateReactionEvent } from "../../src/discord/broadcast-feedback-listener.js"
import {
  FEEDBACK_DOWN_EMOJI,
  FEEDBACK_UP_EMOJI,
} from "../../src/broadcast-feedback/schemas.js"

const OPERATOR = "200000000000000002"
const CHANNEL = "300000000000000003"

const CONFIG = {
  enabled: true,
  channelId: CHANNEL,
  followupTtlHours: 72,
  reconcileMaxMessages: 100,
} as const

function gate(overrides: Partial<Parameters<typeof gateReactionEvent>[0]> = {}) {
  return gateReactionEvent({
    config: CONFIG,
    operatorUserId: OPERATOR,
    reactingUserId: OPERATOR,
    channelId: CHANNEL,
    emoji: FEEDBACK_UP_EMOJI,
    ...overrides,
  })
}

describe("broadcast feedback reaction gate", () => {
  it("admits an operator reaction in the configured channel", () => {
    expect(gate().admit).toBe(true)
    expect(gate({ emoji: FEEDBACK_DOWN_EMOJI }).admit).toBe(true)
  })

  it("rejects every other user", () => {
    expect(gate({ reactingUserId: "400000000000000004" })).toEqual({
      admit: false,
      reason: "not-operator",
    })
  })

  it("rejects every other channel", () => {
    expect(gate({ channelId: "500000000000000005" })).toEqual({
      admit: false,
      reason: "wrong-channel",
    })
  })

  it("rejects every other emoji", () => {
    expect(gate({ emoji: "🔥" })).toEqual({
      admit: false,
      reason: "unsupported-emoji",
    })
  })

  it("stays closed when feedback is off or unconfigured", () => {
    expect(gate({ config: { ...CONFIG, enabled: false } })).toEqual({
      admit: false,
      reason: "feedback-disabled",
    })
    expect(gate({
      config: {
        enabled: true,
        followupTtlHours: 72,
        reconcileMaxMessages: 100,
      },
    })).toEqual({ admit: false, reason: "feedback-disabled" })
  })

  it("stays closed when the operator id is unset", () => {
    expect(gateReactionEvent({
      config: CONFIG,
      reactingUserId: OPERATOR,
      channelId: CHANNEL,
      emoji: FEEDBACK_UP_EMOJI,
    })).toEqual({ admit: false, reason: "operator-unset" })
  })
})
