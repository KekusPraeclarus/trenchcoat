import { describe, expect, it } from "vitest"
import {
  runWatchUpdateWriter,
  validateWatchUpdateOutput,
  watchUpdateUserMessage,
  WATCH_UPDATE_MODEL,
} from "../../src/discord/watch-update-session.js"

describe("discord watch update session", () => {
  it("builds user message with brief and glossed metrics", () => {
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
    expect(msg).toContain("X engagement (likes+replies+reposts): 200 → 91")
    expect(msg).toContain("about 55% lower")
    expect(msg).not.toContain("scanAt:")
  })

  it("glosses security flag changes for the model", () => {
    const msg = watchUpdateUserMessage({
      chain: "robinhood",
      tokenAddress: "0xB47f4702DEB124cb4eB6286be83c9d84277C6239",
      symbolDisplay: "KARMA",
      observedAt: "2026-07-20T11:00:05.000Z",
      changes: [{
        reason: "security-flags",
        label: "Security flags",
        prior: "unverified-source",
        current: "none",
      }],
      agentRoot: "/tmp/agent",
    })
    expect(msg).toContain("Security flags cleared: contract source not verified → none")
    expect(msg).not.toContain("unverified-source → none")
  })

  it("normalizes em-dashes instead of rejecting", () => {
    const checked = validateWatchUpdateOutput("Engagement cooled — narrative fading.")
    expect(checked.ok).toBe(true)
    if (checked.ok) expect(checked.text).toBe("Engagement cooled - narrative fading.")
  })

  it("accepts clean voice output", () => {
    const checked = validateWatchUpdateOutput(
      "Engagement halved since the scan.\n\nSocial traction is fading vs the KOL-led setup.",
    )
    expect(checked.ok).toBe(true)
  })

  it("falls back to soft prose after retry on session error", async () => {
    let attempts = 0
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
        attempts += 1
        throw new Error("offline")
      },
    })
    expect(attempts).toBe(2)
    expect(result.usedFallback).toBe(true)
    expect(result.text).toContain("X engagement cooled hard (200 → 91).")
    expect(result.text).not.toContain("Scan:")
    expect(result.text).not.toContain("- X engagement:")
  })

  it("retries once on validation failure before fallback", async () => {
    let attempts = 0
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
        attempts += 1
        return attempts === 1 ? "" : "Engagement cooled. Spam wave looks dead."
      },
    })
    expect(attempts).toBe(2)
    expect(result.usedFallback).toBe(false)
    expect(result.text).toBe("Engagement cooled. Spam wave looks dead.")
  })

  it("uses composer-2.5 when no custom runner", () => {
    expect(WATCH_UPDATE_MODEL).toBe("composer-2.5")
  })
})
