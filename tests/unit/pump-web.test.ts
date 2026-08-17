import { describe, expect, it } from "vitest"
import {
  describeHandleField,
  extractArrayPayload,
  indexPumpUsernames,
  mapCallerCall,
  mapFeedItem,
  mapLeaderboardEntry,
} from "../../src/collectors/pump/mappers.js"
import { redactPumpCapturePath, PUMP_FEED_TAB_LABEL, PUMP_HOME_PATH } from "../../src/collectors/pump/web-client.js"
import {
  emptyUsageDay,
  remainingBudget,
  reserveAttempt,
} from "../../src/collectors/pump/usage.js"
import fyp from "../fixtures/providers/pump/fyp.json" with { type: "json" }
import leaderboard from "../fixtures/providers/pump/leaderboard.json" with { type: "json" }
import callerCalls from "../fixtures/providers/pump/caller-calls.json" with { type: "json" }

const MINT = "EN2nnxrg8uUi6x2sJkzNPd2eT6rB9rdSoQNNaENA4RZA"
const NOW = "2026-08-13T12:00:00.000Z"

describe("pump mappers", () => {
  it("maps feed items and drops missing mint", () => {
    const mapped = mapFeedItem(fyp.items[0], "fyp", NOW)
    expect(mapped?.author).toBe("alice.calls")
    expect(mapped?.mint).toBeDefined()
    expect(mapFeedItem({ id: "x", author: "bob" }, "fyp", NOW)).toBeUndefined()
  })

  it("maps a valid mint item", () => {
    const mapped = mapFeedItem({
      id: "coin-1",
      author: "alice.calls",
      mint: MINT,
      chain: "solana",
    }, "top", NOW)
    expect(mapped).toMatchObject({ itemId: "coin-1", author: "alice.calls", mint: MINT, tab: "top" })
  })

  it("maps nested creator username and ignores a raw creator address", () => {
    const mapped = mapFeedItem({
      id: "coin-2",
      mint: MINT,
      chain: "solana",
      creator: { username: "carol.calls" },
    }, "news", NOW)
    expect(mapped?.author).toBe("carol.calls")
    expect(mapFeedItem({
      id: "coin-3",
      mint: MINT,
      chain: "solana",
      creator: MINT,
    }, "fyp", NOW)).toBeUndefined()
  })

  it("joins a coin creator to a users-batch username", () => {
    const usernames = indexPumpUsernames([
      { address: MINT, username: "dave.calls" },
    ])
    const mapped = mapFeedItem({
      mint: MINT,
      chain: "solana",
      creator: MINT,
    }, "fyp", NOW, usernames)
    expect(mapped?.author).toBe("dave.calls")
    expect(mapped?.itemId).toBe(MINT)
  })

  it("maps a callout via coinMint and userId join", () => {
    const usernames = indexPumpUsernames([
      { address: MINT, username: "eve.calls" },
    ])
    const mapped = mapFeedItem({
      calloutId: "7be8fa6f-55a6-4802-8246-be197dbc9515",
      userId: MINT,
      coinMint: MINT,
      createdAt: NOW,
    }, "fyp", NOW, usernames)
    expect(mapped).toMatchObject({
      itemId: "7be8fa6f-55a6-4802-8246-be197dbc9515",
      author: "eve.calls",
      mint: MINT,
    })
  })

  it("maps pnl-leaderboard rows from xUsername or wallet join", () => {
    expect(mapLeaderboardEntry({
      rank: 1,
      username: null,
      xUsername: "alice_x",
      walletAddress: MINT,
    }, NOW, 1)?.handle).toBe("alice_x")
    const usernames = indexPumpUsernames([{ address: MINT, username: "bob.calls" }])
    expect(mapLeaderboardEntry({
      rank: 2,
      username: null,
      walletAddress: MINT,
    }, NOW, 2, usernames)?.handle).toBe("bob.calls")
  })

  it("indexes batch users from username or xUsername", () => {
    const usernames = indexPumpUsernames([
      { address: MINT, username: null, xUsername: "eve_x" },
    ])
    expect(usernames.get(MINT)).toBe("eve_x")
  })

  it("keeps feed tabs on the homepage", () => {
    expect(PUMP_HOME_PATH).toBe("/")
    expect(PUMP_FEED_TAB_LABEL).toEqual({
      fyp: "For you",
      top: "Top",
      news: "News",
      following: "Following",
    })
  })

  it("classifies handle field shapes without values", () => {
    expect(describeHandleField("alice.calls")).toBe("handle")
    expect(describeHandleField("")).toBe("empty")
    expect(describeHandleField("cool name")).toBe("spaces")
  })

  it("strips wallet fields from leaderboard rows", () => {
    const entry = mapLeaderboardEntry(leaderboard.users[0], NOW, 1)
    expect(entry?.handle).toBe("lb-alpha")
    expect(entry && "address" in entry).toBe(false)
    expect(JSON.stringify(entry)).not.toMatch(/DROP-THIS/u)
  })

  it("maps caller calls", () => {
    const call = mapCallerCall(callerCalls.calls[0], "alice.calls", NOW)
    expect(call?.callerId).toBe("alice.calls")
    expect(call?.tokenAddress).toBeDefined()
  })

  it("extracts array payloads", () => {
    expect(extractArrayPayload(fyp).length).toBe(1)
    expect(extractArrayPayload({ data: { items: [1, 2] } })).toEqual([1, 2])
    expect(extractArrayPayload({
      callouts: [{ coinMint: MINT, calloutId: "c1" }],
    })).toEqual([{ coinMint: MINT, calloutId: "c1" }])
  })
})

describe("pump capture path redaction", () => {
  it("replaces address-shaped path segments", () => {
    expect(redactPumpCapturePath(`/users/${MINT}/coins`)).toBe("/users/:id/coins")
  })
})

describe("pump navigation budget", () => {
  it("debits reserved navigations from the daily ledger", () => {
    const day = emptyUsageDay("2026-08-13", 200)
    const reserved = reserveAttempt(day, {
      requestId: "req-1",
      endpointFamily: "feed",
      at: NOW,
    })
    expect(remainingBudget(reserved.day)).toBe(199)
    expect(reserved.day.reserved).toBe(1)
  })
})
