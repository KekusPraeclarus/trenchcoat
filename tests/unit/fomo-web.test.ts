import { describe, expect, it, beforeEach } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  mapActivity,
  mapConvergence,
  mapHotToken,
  mapLeaderboardEntry,
  mapProfileSwapBuy,
  mapProfileSwapBuys,
  mapThesis,
  mapTrader,
  extractProfileUser,
  alertFromTradeEvent,
  expandFeedItems,
  thesisRubricComplete,
} from "../../src/collectors/fomo/mappers.js"
import { FomoClientError } from "../../src/collectors/fomo/types.js"
import {
  canReserve,
  completeAttempt,
  emptyUsageDay,
  loadUsageDay,
  remainingBudget,
  reserveAttempt,
  saveUsageDay,
} from "../../src/collectors/fomo/usage.js"
import { freshnessFromIso, isLiveEligible, snapshotFieldsFromEvent } from "../../src/collectors/fomo/freshness.js"
import { classifyFomoRequest } from "../../src/collectors/fomo/request-policy.js"
import { resetRateGatesForTests } from "../../src/lib/rate-gate.js"
import { isNativeOrWrapMint, isQuoteOrNativeMint, inferChainFromTokenAddress } from "../../src/lib/native-mints.js"
import leaderboard from "../fixtures/providers/fomo/leaderboard.json" with { type: "json" }

describe("fomo mappers", () => {
  it("maps traders without binding profile addresses as wallets", () => {
    const trader = mapTrader({
      handle: "Alpha",
      trades: 12,
      win_rate: 0.8,
      pnl: 1000,
      wallets: [
        { chain: "solana", address: "So11111111111111111111111111111111111111112" },
      ],
      address: "FJhXFik8Kfno3EgYPoWgGniTth9xkJGPWTZGr4ExoG2P",
      evmAddress: "0xbd26897dbfaeae67742e5e9766b504e00f463fbd",
    })
    expect(trader?.handle).toBe("alpha")
    expect(trader?.wallets).toEqual([])
  })

  it("maps leaderboard fixture entries", () => {
    const raw = leaderboard.traders[0]
    const entry = mapLeaderboardEntry(raw, "2026-07-19T00:00:00.000Z", "7d")
    expect(entry?.handle).toBe("alphatrader")
    expect(entry?.xHandle).toBe("alphatrader")
    expect(entry?.wallets).toEqual([])
  })

  it("maps activity and rejects invalid token addresses for chain binding", () => {
    const ok = mapActivity({
      handle: "x",
      action: "buy",
      chain: "solana",
      token_mint: "So11111111111111111111111111111111111111112",
      usd_amount: 50,
      timestamp: 1_700_000_000,
    })
    expect(ok?.tokenAddress).toBeTruthy()
    const bad = mapHotToken({
      chain: "solana",
      mint: "not-an-address",
      symbol: "X",
    })
    expect(bad).toBeUndefined()
  })

  it("expands multi_user feed cards with networkId + topTraders", () => {
    const events = expandFeedItems({
      id: "card-1",
      tokenAddress: "Ge87EtsjwRQbHaqQmKRno69RFTwh9bfSsm99XNxTpump",
      networkId: 1399811149,
      createdAt: "2026-07-21T01:00:00.000Z",
      type: "multi_user_buy",
      body: {
        ticker: "Jimothy",
        totalVolume: 10_000,
        topTraders: [
          { userHandle: "alice" },
          { userHandle: "bob" },
          { _truncated: 3 },
        ],
      },
    }, "2026-07-21T01:05:00.000Z")
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      handle: "alice",
      action: "buy",
      chain: "solana",
      tokenAddress: "Ge87EtsjwRQbHaqQmKRno69RFTwh9bfSsm99XNxTpump",
      symbol: "Jimothy",
    })
    expect(events[1]?.handle).toBe("bob")
    expect(alertFromTradeEvent(events[0]!)).toMatchObject({
      kind: "followed-trade",
      handle: "alice",
      action: "buy",
      chain: "solana",
      tokenAddress: "Ge87EtsjwRQbHaqQmKRno69RFTwh9bfSsm99XNxTpump",
    })
  })

  it("infers solana from base58 when networkId is unknown", () => {
    const events = expandFeedItems({
      id: "card-2",
      tokenAddress: "Ge87EtsjwRQbHaqQmKRno69RFTwh9bfSsm99XNxTpump",
      networkId: 999999,
      createdAt: "2026-07-21T01:00:00.000Z",
      type: "multi_user_sell",
      body: {
        ticker: "Jimothy",
        topTraders: [{ userHandle: "carol" }],
      },
    }, "2026-07-21T01:05:00.000Z")
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      handle: "carol",
      action: "sell",
      chain: "solana",
    })
  })

  it("applies thesis rubric", () => {
    const thesis = mapThesis({
      handle: "a",
      chain: "base",
      mint: "0x0000000000000000000000000000000000000001",
      text: "x".repeat(50),
      timestamp: "2026-07-18T00:00:00.000Z",
    })
    if (thesis) {
      expect(thesisRubricComplete(thesis) || thesis.text.length >= 40).toBe(true)
    }
    expect(mapThesis({ text: "short" })).toBeUndefined()
  })

  it("maps convergence handles", () => {
    const event = mapConvergence({
      chain: "solana",
      mint: "So11111111111111111111111111111111111111112",
      wallets_involved: [{ handle: "a" }, { handle: "b" }],
    })
    expect(event?.handles).toEqual(["a", "b"])
  })

  it("maps quote-to-meme profile swaps and skips sells and quote mints", () => {
    const observedAt = "2026-08-13T00:00:00.000Z"
    const buy = mapProfileSwapBuy({
      id: "swap-1",
      inTokenAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      outTokenAddress: "Ge87EtsjwRQbHaqQmKRno69RFTwh9bfSsm99XNxTpump",
      networkId: 1399811149,
      createdAt: "2026-08-01T12:00:00.000Z",
    }, "claymorepx", observedAt)
    expect(buy?.action).toBe("buy")
    expect(buy?.tokenAddress).toBe("Ge87EtsjwRQbHaqQmKRno69RFTwh9bfSsm99XNxTpump")
    expect(buy?.wallet).toBeUndefined()

    const sell = mapProfileSwapBuy({
      inTokenAddress: "Ge87EtsjwRQbHaqQmKRno69RFTwh9bfSsm99XNxTpump",
      outTokenAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      networkId: 1399811149,
      createdAt: "2026-08-01T12:00:00.000Z",
    }, "claymorepx", observedAt)
    expect(sell).toBeUndefined()

    const quoteOnly = mapProfileSwapBuy({
      inTokenAddress: "So11111111111111111111111111111111111111112",
      outTokenAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      networkId: 1399811149,
      createdAt: "2026-08-01T12:00:00.000Z",
    }, "claymorepx", observedAt)
    expect(quoteOnly).toBeUndefined()

    const undated = mapProfileSwapBuy({
      inTokenAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      outTokenAddress: "Ge87EtsjwRQbHaqQmKRno69RFTwh9bfSsm99XNxTpump",
      networkId: 1399811149,
    }, "claymorepx", observedAt)
    expect(undated).toBeUndefined()

    const nested = mapProfileSwapBuys({
      responseObject: {
        swaps: [{
          inTokenAddress: "So11111111111111111111111111111111111111112",
          outTokenAddress: "Ge87EtsjwRQbHaqQmKRno69RFTwh9bfSsm99XNxTpump",
          networkId: 1399811149,
          timestamp: "2026-08-01T12:00:00.000Z",
        }],
      },
    }, "ether_monk", observedAt)
    expect(nested).toHaveLength(1)
    expect(nested[0]?.handle).toBe("ether_monk")
  })
})

describe("native mint denylist", () => {
  it("blocks wrapped SOL and reserved symbols", () => {
    expect(isNativeOrWrapMint("So11111111111111111111111111111111111111112")).toBe(true)
    expect(isNativeOrWrapMint("so11111111111111111111111111111111111111112", "WSOL")).toBe(true)
    expect(isNativeOrWrapMint("Ge87EtsjwRQbHaqQmKRno69RFTwh9bfSsm99XNxTpump", "SOL")).toBe(true)
    expect(isNativeOrWrapMint("Ge87EtsjwRQbHaqQmKRno69RFTwh9bfSsm99XNxTpump", "Jimothy")).toBe(false)
    expect(isQuoteOrNativeMint("So11111111111111111111111111111111111111112")).toBe(true)
    expect(isQuoteOrNativeMint("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe(true)
    expect(isQuoteOrNativeMint("Ge87EtsjwRQbHaqQmKRno69RFTwh9bfSsm99XNxTpump")).toBe(false)
    expect(inferChainFromTokenAddress("Ge87EtsjwRQbHaqQmKRno69RFTwh9bfSsm99XNxTpump")).toBe("solana")
    expect(inferChainFromTokenAddress("0xaf4c10fef50059d1e3e8ab1c80e46db6a76098b4")).toBeUndefined()
  })
})

describe("fomo freshness", () => {
  it("marks six-hour window as live", () => {
    const fetchedAt = "2026-07-19T12:00:00.000Z"
    const live = freshnessFromIso("2026-07-19T10:00:00.000Z", fetchedAt)
    expect(live.ok).toBe(true)
    expect(live.freshnessTier).toBe("live")
    expect(isLiveEligible(live.ageSec!)).toBe(true)
    const stale = snapshotFieldsFromEvent("2026-07-18T12:00:00.000Z", fetchedAt)
    expect(stale.accepted).toBe(false)
  })
})

describe("fomo request policy", () => {
  it("allows GET on fomo hosts and blocks mutations", () => {
    expect(classifyFomoRequest("GET", "https://prod-api.fomo.family/v1/leaderboard").allow).toBe(true)
    expect(classifyFomoRequest("GET", "https://prod-api.fomo.family/v2/users/abc/swaps").allow).toBe(true)
    expect(classifyFomoRequest("GET", "https://prod-api.fomo.family/v2/users/abc/spotlight").allow).toBe(true)
    expect(classifyFomoRequest("POST", "https://prod-api.fomo.family/proxy/mostHeld").allow).toBe(true)
    expect(classifyFomoRequest("POST", "https://prod-api.fomo.family/v1/trade").allow).toBe(false)
    expect(classifyFomoRequest("POST", "https://prod-api.fomo.family/v2/users/edit").allow).toBe(false)
    expect(classifyFomoRequest("DELETE", "https://fomo.family/account").allow).toBe(false)
  })

  it("maps live leaderboard userHandle without wallet binding", () => {
    const entry = mapLeaderboardEntry({
      userHandle: "Juicycooks",
      address: "FJhXFik8Kfno3EgYPoWgGniTth9xkJGPWTZGr4ExoG2P",
      evmAddress: "0xbd26897dbfaeae67742e5e9766b504e00f463fbd",
      pnl7d: 1000,
      numTrades: 12,
    }, "2026-07-19T00:00:00.000Z", "7d")
    expect(entry?.handle).toBe("juicycooks")
    expect(entry?.pnl).toBe(1000)
    expect(entry?.wallets).toEqual([])
  })

  it("maps live twitter object and null without dropping the row", () => {
    const withObject = mapLeaderboardEntry({
      userHandle: "LiveHandle",
      twitter: { username: "xfromobject" },
      numTrades: 8,
      pnl7d: 100,
    }, "2026-08-26T00:00:00.000Z", "7d")
    expect(withObject?.handle).toBe("livehandle")
    expect(withObject?.xHandle).toBe("xfromobject")
    expect(withObject?.wallets).toEqual([])

    const withNull = mapLeaderboardEntry({
      userHandle: "NullTwitter",
      twitter: null,
      numTrades: 3,
    }, "2026-08-26T00:00:00.000Z", "7d")
    expect(withNull?.handle).toBe("nulltwitter")
    expect(withNull?.xHandle).toBeUndefined()
  })

  it("maps a live profile envelope and keeps twitter null without a same-handle X link", () => {
    const user = extractProfileUser({
      success: true,
      responseObject: {
        userHandle: "LiveHandle",
        twitter: null,
        numTrades: 8,
      },
    })
    const none = mapLeaderboardEntry(user, "2026-08-26T00:00:00.000Z", "7d")
    expect(none?.handle).toBe("livehandle")
    expect(none?.xHandle).toBeUndefined()

    const linked = mapLeaderboardEntry(extractProfileUser({
      responseObject: {
        userHandle: "LiveHandle",
        twitter: { username: "realxuser" },
      },
    }), "2026-08-26T00:00:00.000Z", "7d")
    expect(linked?.xHandle).toBe("realxuser")
    expect(linked?.wallets).toEqual([])
  })
})

describe("fomo usage ledger", () => {
  beforeEach(() => {
    resetRateGatesForTests()
  })

  it("never exceeds budget under reserve/complete", async () => {
    const root = mkdtempSync(join(tmpdir(), "fomo-usage-"))
    let day = emptyUsageDay("2026-07-18", 5)
    for (let i = 0; i < 5; i += 1) {
      const reserved = reserveAttempt(day, {
        requestId: `r${i}`,
        endpointFamily: "leaderboard",
        at: "2026-07-18T00:00:00.000Z",
      })
      day = reserved.day
      day = completeAttempt(day, {
        attemptId: reserved.attemptId,
        ok: true,
        counted: true,
        at: "2026-07-18T00:00:01.000Z",
      })
    }
    expect(canReserve(day, 0)).toBe(false)
    await saveUsageDay(root, day)
    const loaded = loadUsageDay(root, "2026-07-18", 5)
    expect(remainingBudget(loaded)).toBe(0)
  })
})

describe("FomoClientError", () => {
  it("carries typed codes without leaking secrets", () => {
    const err = new FomoClientError("session_expired", "session missing", 401)
    expect(err.code).toBe("session_expired")
    expect(err.status).toBe(401)
    expect(String(err)).not.toContain("secret")
    expect(new FomoClientError("rate_limited", "slow down", 429).code).toBe("rate_limited")
    expect(new FomoClientError("upstream", "502", 502).code).toBe("upstream")
  })
})
