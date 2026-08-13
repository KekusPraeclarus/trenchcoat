import { describe, expect, it } from "vitest"
import fyp from "../fixtures/providers/pump/fyp.json" with { type: "json" }
import top from "../fixtures/providers/pump/top.json" with { type: "json" }
import news from "../fixtures/providers/pump/news.json" with { type: "json" }
import following from "../fixtures/providers/pump/following.json" with { type: "json" }
import leaderboard from "../fixtures/providers/pump/leaderboard.json" with { type: "json" }
import callerCalls from "../fixtures/providers/pump/caller-calls.json" with { type: "json" }
import unavailable from "../fixtures/providers/pump/unavailable.json" with { type: "json" }
import { mapFeedItem, mapLeaderboardEntry, mapCallerCall } from "../../src/collectors/pump/mappers.js"
import { PumpClientError } from "../../src/collectors/pump/types.js"

const NOW = "2026-08-13T12:00:00.000Z"

describe("pump web contract fixtures", () => {
  it("maps fyp top news and following fixtures", () => {
    expect(mapFeedItem(fyp.items[0], "fyp", NOW)?.itemId).toBe("coin-alpha-1")
    expect(mapFeedItem(top.items[0], "top", NOW)).toBeDefined()
    expect(mapFeedItem(news.items[0], "news", NOW)).toBeDefined()
    expect(mapFeedItem(following.items[0], "following", NOW)).toBeDefined()
  })

  it("maps leaderboard handles and drops addresses", () => {
    const mapped = mapLeaderboardEntry(leaderboard.users[0], NOW, 1)
    expect(mapped?.handle).toBe("lb-alpha")
    expect(JSON.stringify(mapped)).not.toMatch(/DROP-THIS/u)
  })

  it("maps caller-call fixtures", () => {
    expect(mapCallerCall(callerCalls.calls[0], "alice.calls", NOW)?.callerId).toBe("alice.calls")
  })

  it("unavailable fixture documents typed upstream failure", () => {
    expect(unavailable.status).toBe(502)
    const err = new PumpClientError("upstream", String(unavailable.error), unavailable.status)
    expect(err.code).toBe("upstream")
  })
})
