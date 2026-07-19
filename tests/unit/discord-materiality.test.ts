import { describe, expect, it } from "vitest"
import {
  detectMaterialChanges,
  renderWatchUpdateFactsOnly,
} from "../../src/discord/materiality.js"
import type { DiscordObservation } from "../../src/discord/schemas.js"

function base(): DiscordObservation {
  return {
    observedAt: "2026-07-19T00:00:00.000Z",
    priceUsd: 100,
    liquidityUsd: 1000,
    volume24hUsd: 1_220_000,
    fdvUsd: 10_000,
    buys24h: 10,
    sells24h: 8,
    securityStatus: "pass",
    securityFlags: [],
    xPostCount: 5,
    xAuthorCount: 29,
    xRecentCount: 5,
    xKnownLikes: 100,
    xKnownViews: null,
    xKnownReplies: 20,
    xKnownReposts: 80,
    xAuthorIds: Array.from({ length: 29 }, (_, i) => `a${i}`),
  }
}

describe("discord materiality", () => {
  it("fires at 50% price move", () => {
    const prior = base()
    const current = { ...base(), priceUsd: 151 }
    expect(detectMaterialChanges(prior, current).some((c) => c.reason === "price")).toBe(true)
  })

  it("does not fire just below 50% price move", () => {
    const prior = base()
    const current = { ...base(), priceUsd: 149 }
    expect(detectMaterialChanges(prior, current).some((c) => c.reason === "price")).toBe(false)
  })

  it("ignores null prior values", () => {
    const prior = { ...base(), priceUsd: null }
    const current = { ...base(), priceUsd: 200 }
    expect(detectMaterialChanges(prior, current)).toHaveLength(0)
  })

  it("ignores modest volume uptick (CRED-style)", () => {
    const prior = base()
    const current = { ...base(), volume24hUsd: 1_660_000 }
    expect(detectMaterialChanges(prior, current)).toHaveLength(0)
  })

  it("fires when volume doubles", () => {
    const prior = base()
    const current = { ...base(), volume24hUsd: 2_440_000 }
    expect(detectMaterialChanges(prior, current).some((c) => c.reason === "volume")).toBe(true)
  })

  it("ignores small net author churn", () => {
    const prior = base()
    const current = {
      ...base(),
      xAuthorIds: [...prior.xAuthorIds, "new1", "new2"],
      xAuthorCount: 31,
    }
    expect(detectMaterialChanges(prior, current)).toHaveLength(0)
  })

  it("ignores net +49 authors", () => {
    const prior = base()
    const extra = Array.from({ length: 49 }, (_, i) => `x${i}`)
    const current = {
      ...base(),
      xAuthorIds: [...prior.xAuthorIds, ...extra],
    }
    expect(detectMaterialChanges(prior, current)).toHaveLength(0)
  })

  it("fires on net +50 authors", () => {
    const prior = base()
    const extra = Array.from({ length: 50 }, (_, i) => `x${i}`)
    const current = {
      ...base(),
      xAuthorIds: [...prior.xAuthorIds, ...extra],
    }
    const changes = detectMaterialChanges(prior, current)
    expect(changes.some((c) => c.reason === "x-authors")).toBe(true)
    expect(changes.find((c) => c.reason === "x-authors")?.current).toContain("net +50")
  })

  it("fires on net -100 authors", () => {
    const prior = {
      ...base(),
      xAuthorIds: Array.from({ length: 150 }, (_, i) => `a${i}`),
    }
    const current = {
      ...base(),
      xAuthorIds: prior.xAuthorIds.slice(0, 50),
    }
    const changes = detectMaterialChanges(prior, current)
    expect(changes.some((c) => c.reason === "x-authors")).toBe(true)
    expect(changes.find((c) => c.reason === "x-authors")?.current).toContain("net -100")
  })

  it("fires when engagement halves (DREGG-style)", () => {
    const prior = base()
    const current = {
      ...base(),
      xKnownLikes: 50,
      xKnownReplies: 10,
      xKnownReposts: 31,
    }
    expect(detectMaterialChanges(prior, current).some((c) => c.reason === "x-engagement")).toBe(true)
  })

  it("facts-only render has no canned interpretation", () => {
    const text = renderWatchUpdateFactsOnly({
      chain: "solana",
      tokenAddress: "CREDBH1234567890123456789012345678901234",
      symbolDisplay: "CRED",
      observedAt: "2026-07-19T17:00:08.000Z",
      changes: [{
        reason: "volume",
        label: "24h volume",
        prior: "$1.22M",
        current: "$1.66M",
      }],
    })
    expect(text).toContain("24h volume")
    expect(text).not.toContain("shifted materially")
    expect(text).not.toContain("narrative breadth")
  })
})
