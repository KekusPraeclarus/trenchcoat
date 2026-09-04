import { describe, expect, it } from "vitest"
import { applyFomoFollows, emptyFomoFollows, planFomoFollows } from "../../src/sources/fomo-follows.js"
import type { FomoLeaderboardEntry } from "../../src/collectors/fomo/types.js"
import {
  extractFollowingIds,
  FOMO_FOLLOW_NAME,
  FOMO_FOLLOWING_NAME,
} from "../../src/collectors/fomo/engagement.js"

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

  it("skips handles with a recent unverified receipt", () => {
    const planned = planFomoFollows({
      traders: [trader("alpha", 1), trader("beta", 2)],
      followedHandles: [],
      maxFollowing: 80,
      maxFollowsPerRun: 5,
      nowIso: "2026-09-04T12:00:00.000Z",
      receipts: [{
        schema: 1,
        handle: "alpha",
        attemptedAt: "2026-09-03T13:00:00.000Z",
        verified: false,
        ambiguous: true,
        error: "follow-unverified",
      }],
    })
    expect(planned).toEqual(["beta"])
  })

  it("retries a handle after the cooldown window", () => {
    const planned = planFomoFollows({
      traders: [trader("alpha", 1)],
      followedHandles: [],
      maxFollowing: 80,
      maxFollowsPerRun: 5,
      nowIso: "2026-09-04T12:00:00.000Z",
      receipts: [{
        schema: 1,
        handle: "alpha",
        attemptedAt: "2026-09-03T11:00:00.000Z",
        verified: false,
        ambiguous: true,
      }],
    })
    expect(planned).toEqual(["alpha"])
  })

  it("treats count chips as not followed", () => {
    expect(FOMO_FOLLOW_NAME.test("Follow")).toBe(true)
    expect(FOMO_FOLLOW_NAME.test("Following")).toBe(false)
    expect(FOMO_FOLLOWING_NAME.test("Following")).toBe(true)
    expect(FOMO_FOLLOWING_NAME.test("310Following")).toBe(false)
    expect(FOMO_FOLLOWING_NAME.test("234,355Followers")).toBe(false)
    expect(extractFollowingIds({
      responseObject: { followingIds: ["aefe2ddd-c580-5245-a2f5-e4ed62f7ef10"] },
    })).toEqual(["aefe2ddd-c580-5245-a2f5-e4ed62f7ef10"])
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
