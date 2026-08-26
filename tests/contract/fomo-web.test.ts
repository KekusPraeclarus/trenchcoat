import { describe, expect, it } from "vitest"
import leaderboard from "../fixtures/providers/fomo/leaderboard.json" with { type: "json" }
import unavailable from "../fixtures/providers/fomo/unavailable.json" with { type: "json" }
import { mapLeaderboardEntry, mapTrader } from "../../src/collectors/fomo/mappers.js"
import { FomoClientError } from "../../src/collectors/fomo/types.js"

describe("fomo web contract fixtures", () => {
  it("maps leaderboard fixture traders", () => {
    const mapped = leaderboard.traders
      .map((raw) => mapLeaderboardEntry(raw, "2026-07-19T00:00:00.000Z", "7d") ?? mapTrader(raw, "2026-07-19T00:00:00.000Z"))
      .filter(Boolean)
    expect(mapped.length).toBe(leaderboard.traders.length)
    expect(mapped[0]?.handle).toBeTruthy()
    const live = mapped.find((row) => row?.handle === "livehandle")
    expect(live?.xHandle).toBe("livehandle")
    expect(live?.wallets).toEqual([])
  })

  it("unavailable fixture documents typed upstream failure", () => {
    expect(unavailable.status).toBe(502)
    const err = new FomoClientError("upstream", String(unavailable.error), unavailable.status)
    expect(err.code).toBe("upstream")
    expect(err.status).toBe(502)
  })

  it("parses empty leaderboard arrays as empty", () => {
    expect([].map((raw) => mapLeaderboardEntry(raw, "2026-07-19T00:00:00.000Z", "7d"))).toEqual([])
  })
})
