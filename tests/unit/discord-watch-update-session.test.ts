import { describe, expect, it } from "vitest"
import {
  runWatchUpdateWriter,
  validateWatchUpdateOutput,
  watchUpdateUserMessage,
  WATCH_UPDATE_MODEL,
} from "../../src/discord/watch-update-session.js"

describe("discord watch update session", () => {
  it("builds user message with brief and metrics", () => {
    const msg = watchUpdateUserMessage({
      chain: "solana",
      tokenAddress: "abc1234567890123456789012345678901234567890",
      symbolDisplay: "DREGG",
      observedAt: "2026-07-19T17:00:08.000Z",
      changes: [{
        reason: "x-engagement",
        label: "X engagement",
        prior: "200",
        current: "91",
      }],
      researchBrief: "Thin social traction from a few KOLs.",
      agentRoot: "/tmp/agent",
    })
    expect(msg).toContain("<research-brief>")
    expect(msg).toContain("Thin social traction")
    expect(msg).toContain("X engagement: 200 → 91")
  })

  it("rejects em-dashes in output", () => {
    const checked = validateWatchUpdateOutput("Engagement cooled — narrative fading.")
    expect(checked.ok).toBe(false)
    if (!checked.ok) expect(checked.reason).toBe("em-dash")
  })

  it("accepts clean voice output", () => {
    const checked = validateWatchUpdateOutput(
      "Engagement halved since the scan.\n\nSocial traction is fading vs the KOL-led setup.",
    )
    expect(checked.ok).toBe(true)
  })

  it("falls back to facts-only on session error", async () => {
    const result = await runWatchUpdateWriter({
      chain: "solana",
      tokenAddress: "abc1234567890123456789012345678901234567890",
      symbolDisplay: "DREGG",
      observedAt: "2026-07-19T17:00:08.000Z",
      changes: [{
        reason: "x-engagement",
        label: "X engagement",
        prior: "200",
        current: "91",
      }],
      agentRoot: "/tmp/agent",
      runSession: async () => {
        throw new Error("offline")
      },
    })
    expect(result.usedFallback).toBe(true)
    expect(result.text).toContain("X engagement: 200 → 91")
    expect(result.text).not.toContain("shifted materially")
  })

  it("uses composer-2.5 when no custom runner", () => {
    expect(WATCH_UPDATE_MODEL).toBe("composer-2.5")
  })
})
