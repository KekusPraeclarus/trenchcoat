import { describe, expect, it } from "vitest"
import {
  dedupeTradeEvents,
  deriveConvergence,
  derivePressure,
  qualifiedHandleSet,
  trendingSignals,
} from "../../src/collectors/fomo/derive.js"
import type { FomoLeaderboardEntry, FomoTradeEvent, FomoTrendingObservation } from "../../src/collectors/fomo/types.js"

function trade(partial: {
  handle: string
  tokenAddress: string
  eventAt: string
  action?: "buy" | "sell"
  chain?: string
  usdAmount?: number
  sourceId?: string
  observedAt?: string
}): FomoTradeEvent {
  return {
    sourceId: partial.sourceId ?? `${partial.handle}-${partial.eventAt}-${partial.action ?? "buy"}`,
    handle: partial.handle,
    action: partial.action ?? "buy",
    chain: partial.chain ?? "solana",
    tokenAddress: partial.tokenAddress,
    eventAt: partial.eventAt,
    observedAt: partial.observedAt ?? partial.eventAt,
    ...(partial.usdAmount !== undefined ? { usdAmount: partial.usdAmount } : {}),
  }
}

describe("fomo signal derivation", () => {
  it("dedupes identical trade events", () => {
    const a = trade({
      handle: "a",
      tokenAddress: "Tok1",
      eventAt: "2026-07-19T10:00:00.000Z",
      usdAmount: 1_000,
      sourceId: "same",
    })
    const b = { ...a }
    expect(dedupeTradeEvents([a, b])).toHaveLength(1)
  })

  it("derives convergence from two qualified buyers in the window", () => {
    const board: FomoLeaderboardEntry[] = [
      { handle: "a", timeframe: "7d", rank: 1, wallets: [], observedAt: "2026-07-19T10:00:00.000Z" },
      { handle: "b", timeframe: "7d", rank: 2, wallets: [], observedAt: "2026-07-19T10:00:00.000Z" },
    ]
    const signals = deriveConvergence({
      events: [
        trade({ handle: "a", tokenAddress: "Tok1", eventAt: "2026-07-19T10:00:00.000Z", usdAmount: 600 }),
        trade({ handle: "b", tokenAddress: "Tok1", eventAt: "2026-07-19T10:20:00.000Z", usdAmount: 700 }),
      ],
      qualifiedHandles: qualifiedHandleSet(board),
      windowMinutes: 60,
      minTraders: 2,
      observedAt: "2026-07-19T10:30:00.000Z",
    })
    expect(signals.some((s) => s.kind === "convergence")).toBe(true)
  })

  it("derives pressure without requiring USD on every trade", () => {
    const board: FomoLeaderboardEntry[] = [
      { handle: "a", timeframe: "7d", rank: 1, wallets: [], observedAt: "2026-07-19T10:00:00.000Z" },
      { handle: "b", timeframe: "7d", rank: 2, wallets: [], observedAt: "2026-07-19T10:00:00.000Z" },
      { handle: "c", timeframe: "7d", rank: 3, wallets: [], observedAt: "2026-07-19T10:00:00.000Z" },
    ]
    const signals = derivePressure({
      events: [
        trade({ handle: "a", tokenAddress: "Tok1", eventAt: "2026-07-19T10:00:00.000Z", action: "buy" }),
        trade({ handle: "b", tokenAddress: "Tok1", eventAt: "2026-07-19T10:05:00.000Z", action: "buy" }),
        trade({ handle: "c", tokenAddress: "Tok1", eventAt: "2026-07-19T10:10:00.000Z", action: "buy" }),
      ],
      qualifiedHandles: qualifiedHandleSet(board),
      windowMinutes: 60,
      minTraders: 3,
      side: "buy",
      observedAt: "2026-07-19T10:30:00.000Z",
    })
    expect(signals.some((s) => s.kind === "buy-pressure")).toBe(true)
  })

  it("caps trending signals at top ten", () => {
    const rows: FomoTrendingObservation[] = Array.from({ length: 15 }, (_, i) => ({
      rank: i + 1,
      chain: "solana",
      tokenAddress: `Tok${i}`,
      observedAt: "2026-07-19T10:00:00.000Z",
    }))
    expect(trendingSignals(rows, "2026-07-19T10:00:00.000Z")).toHaveLength(10)
  })
})
