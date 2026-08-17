import { describe, expect, it } from "vitest"
import { applyFomoFollows, emptyFomoFollows, planFomoFollows } from "../../src/sources/fomo-follows.js"
import type { FomoLeaderboardEntry } from "../../src/collectors/fomo/types.js"

function trader(handle: string, rank: number): FomoLeaderboardEntry {
  return {
    handle,
    timeframe: "7d",
    rank,
    wallets: [{ chain: "solana", address: "So11111111111111111111111111111111111111112" }],
    observedAt: "2026-08-17T00:00:00.000Z",
  }
}

describe("fomo platform follows", () => {
  it("plans new handles up to the per-run and following caps", () => {
    const planned = planFomoFollows({
      traders: [trader("alpha", 1), trader("beta", 2), trader("gamma", 3)],
      followedHandles: ["alpha"],
      maxFollowing: 80,
      maxFollowsPerRun: 1,
    })
    expect(planned).toEqual(["beta"])
  })

  it("skips handles already followed and stays idempotent", () => {
    const planned = planFomoFollows({
      traders: [trader("Alpha", 1)],
      followedHandles: ["alpha"],
      maxFollowing: 80,
      maxFollowsPerRun: 5,
    })
    expect(planned).toEqual([])
  })

  it("records verified follows without touching wallets", async () => {
    const applied = await applyFomoFollows({
      file: emptyFomoFollows(),
      traders: [trader("alpha", 1), trader("beta", 2)],
      nowIso: "2026-08-17T12:00:00.000Z",
      maxFollowing: 80,
      maxFollowsPerRun: 5,
      follow: async ({ handle }) => ({ verified: true, ambiguous: false, handle }),
    })
    expect(applied.attempted).toBe(2)
    expect(applied.verified).toBe(2)
    expect(applied.file.followedHandles).toEqual(["alpha", "beta"])
    expect(JSON.stringify(applied.file)).not.toMatch(/So1111|wallets/u)
  })
})
