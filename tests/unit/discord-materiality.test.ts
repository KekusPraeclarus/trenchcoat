import { describe, expect, it } from "vitest"
import { detectMaterialChanges } from "../../src/discord/materiality.js"
import type { DiscordObservation } from "../../src/discord/schemas.js"

function base(): DiscordObservation {
  return {
    observedAt: "2026-07-19T00:00:00.000Z",
    priceUsd: 100,
    liquidityUsd: 1000,
    volume24hUsd: 500,
    fdvUsd: 10_000,
    buys24h: 10,
    sells24h: 8,
    securityStatus: "pass",
    securityFlags: [],
    xPostCount: 5,
    xAuthorCount: 3,
    xRecentCount: 5,
    xKnownLikes: 100,
    xKnownViews: null,
    xKnownReplies: 20,
    xKnownReposts: 10,
    xAuthorIds: ["a1", "a2"],
  }
}

describe("discord materiality", () => {
  it("fires at 20% price move", () => {
    const prior = base()
    const current = { ...base(), priceUsd: 121 }
    expect(detectMaterialChanges(prior, current).some((c) => c.reason === "price")).toBe(true)
  })

  it("does not fire just below 20% price move", () => {
    const prior = base()
    const current = { ...base(), priceUsd: 119 }
    expect(detectMaterialChanges(prior, current).some((c) => c.reason === "price")).toBe(false)
  })

  it("ignores null prior values", () => {
    const prior = { ...base(), priceUsd: null }
    const current = { ...base(), priceUsd: 200 }
    expect(detectMaterialChanges(prior, current)).toHaveLength(0)
  })
})
