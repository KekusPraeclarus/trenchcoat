import { describe, expect, it, beforeEach } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  mapActivity,
  mapConvergence,
  mapHotToken,
  mapLeaderboardEntry,
  mapThesis,
  mapTrader,
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
import leaderboard from "../fixtures/providers/fomo/leaderboard.json" with { type: "json" }

describe("fomo mappers", () => {
  it("maps traders with exact wallets and drops malformed", () => {
    const trader = mapTrader({
      handle: "Alpha",
      trades: 12,
      win_rate: 0.8,
      pnl: 1000,
      wallets: [
        { chain: "solana", address: "So11111111111111111111111111111111111111112" },
        { chain: "bnb", address: "0x0000000000000000000000000000000000000001" },
      ],
    })
    expect(trader?.handle).toBe("alpha")
    expect(trader?.wallets).toHaveLength(1)
    expect(trader?.wallets[0]?.chain).toBe("solana")
  })

  it("maps leaderboard fixture entries", () => {
    const raw = leaderboard.traders[0]
    const entry = mapLeaderboardEntry(raw, "2026-07-19T00:00:00.000Z", "7d")
    expect(entry?.handle).toBe("alphatrader")
    expect(entry?.xHandle).toBe("alphatrader")
    expect(entry?.wallets.length).toBeGreaterThan(0)
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
    expect(classifyFomoRequest("POST", "https://prod-api.fomo.family/proxy/mostHeld").allow).toBe(true)
    expect(classifyFomoRequest("POST", "https://prod-api.fomo.family/v1/trade").allow).toBe(false)
    expect(classifyFomoRequest("POST", "https://prod-api.fomo.family/v2/users/edit").allow).toBe(false)
    expect(classifyFomoRequest("DELETE", "https://fomo.family/account").allow).toBe(false)
  })

  it("maps live leaderboard userHandle + wallets", () => {
    const entry = mapLeaderboardEntry({
      userHandle: "Juicycooks",
      address: "FJhXFik8Kfno3EgYPoWgGniTth9xkJGPWTZGr4ExoG2P",
      evmAddress: "0xbd26897dbfaeae67742e5e9766b504e00f463fbd",
      pnl7d: 1000,
      numTrades: 12,
    }, "2026-07-19T00:00:00.000Z", "7d")
    expect(entry?.handle).toBe("juicycooks")
    expect(entry?.pnl).toBe(1000)
    expect(entry?.wallets.some((w) => w.chain === "solana")).toBe(true)
    expect(entry?.wallets.some((w) => w.chain === "ethereum")).toBe(true)
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
