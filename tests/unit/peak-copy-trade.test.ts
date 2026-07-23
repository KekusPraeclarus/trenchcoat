import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { archiveLayout } from "../../src/lib/archive.js"
import {
  isStillSending,
  materializePeakObservation,
  peakFromEntry,
  type PriceBar,
} from "../../src/orchestrator/observations.js"
import { matchFifoCloses } from "../../src/orchestrator/copy-trade-fifo.js"
import { runSettleSourcePeaks } from "../../src/orchestrator/settle-source-peaks.js"
import { runSettleWalletCopyTrades } from "../../src/orchestrator/settle-wallet-copy-trades.js"
import { runSettleFomoCopyTrades } from "../../src/orchestrator/settle-fomo-copy-trades.js"
import { appendSourceCallEventsFromArchiveInbox } from "../../src/orchestrator/call-log.js"
import { extractSolanaVerifiedSellsFromTransaction } from "../../src/collectors/wallets/helius-provider.js"
import { eligibleWalletTrades } from "../../src/wallets/providers.js"
import { StateStore } from "../../src/lib/state.js"

const TOKEN = "So11111111111111111111111111111111111111112"
const BUYER = "Buyer111111111111111111111111111111111111111"

describe("peak-from-entry helpers", () => {
  const bars: PriceBar[] = [
    { ts: "2026-07-01T00:05:00.000Z", open: 10, high: 11, finalized: true },
    { ts: "2026-07-01T06:00:00.000Z", open: 12, high: 15, finalized: true },
    { ts: "2026-07-01T14:00:00.000Z", open: 14, high: 14.5, finalized: true },
  ]

  it("computes peak return from entry open", () => {
    const peak = peakFromEntry(bars, "2026-07-01T00:00:00.000Z")
    expect(peak?.peakHigh).toBe(15)
    expect(peak?.peakReturn).toBeCloseTo(0.5)
  })

  it("defers while still sending within 6h", () => {
    expect(isStillSending(bars, "2026-07-01T00:05:00.000Z", "2026-07-01T10:00:00.000Z", 6)).toBe(true)
    expect(isStillSending(bars, "2026-07-01T00:05:00.000Z", "2026-07-01T20:05:00.000Z", 6)).toBe(false)
  })

  it("force-completes after 14d even if still sending", () => {
    const obs = materializePeakObservation({
      subjectType: "source-call",
      subjectId: "x_a:tok",
      eventTs: "2026-06-01T00:00:00.000Z",
      bars: [
        { ts: "2026-06-01T00:05:00.000Z", open: 10, high: 11, finalized: true },
        { ts: "2026-06-15T20:00:00.000Z", open: 20, high: 25, finalized: true },
      ],
      observedAt: "2026-06-16T00:00:00.000Z",
      quietHours: 6,
      maxWaitDays: 14,
    })
    expect(obs.status).toBe("complete")
    expect(obs.excessReturn).toBeCloseTo(1.5)
  })
})

describe("source peak settle", () => {
  it("writes provider-pending then completes after quiet 6h", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-peak-"))
    const layout = archiveLayout(root)
    const inbox = join(root, "runs", "run-1", "inbox")
    mkdirSync(inbox, { recursive: true })
    writeFileSync(join(inbox, "tg.json"), `${JSON.stringify({
      source: "telegram",
      fetchedAt: "2026-07-01T00:00:00.000Z",
      trust: "untrusted-external",
      items: [{
        provenance: "telegram:alpha",
        text: `ape ${TOKEN}`,
        ts: "2026-07-01T00:00:00.000Z",
        ageSec: 0,
        freshnessTier: "live",
      }],
    }, null, 2)}\n`)
    await appendSourceCallEventsFromArchiveInbox(layout, "run-1")

    const barsSending: PriceBar[] = [
      { ts: "2026-07-01T00:05:00.000Z", open: 10, high: 11, finalized: true },
      { ts: "2026-07-01T04:00:00.000Z", open: 12, high: 20, finalized: true },
    ]
    const pending = await runSettleSourcePeaks({
      layout,
      nowIso: "2026-07-01T08:00:00.000Z",
      loadBars: () => barsSending,
    })
    expect(pending.pending).toBe(1)

    const barsQuiet: PriceBar[] = [
      ...barsSending,
      { ts: "2026-07-01T10:00:00.000Z", open: 18, high: 18, finalized: true },
    ]
    const done = await runSettleSourcePeaks({
      layout,
      nowIso: "2026-07-01T12:00:00.000Z",
      loadBars: () => barsQuiet,
    })
    expect(done.complete).toBe(1)
  })
})

describe("FIFO copy-trade", () => {
  it("partial sell closes oldest lot first", () => {
    const closes = matchFifoCloses(
      [
        { eventId: "b1", side: "buy", tradedAt: "2026-07-01T00:00:00.000Z", amountRaw: "100" },
        { eventId: "b2", side: "buy", tradedAt: "2026-07-01T01:00:00.000Z", amountRaw: "100" },
        { eventId: "s1", side: "sell", tradedAt: "2026-07-01T02:00:00.000Z", amountRaw: "40" },
      ],
      (buyAt, sellAt) => {
        void sellAt
        return buyAt.startsWith("2026-07-01T00") ? 0.5 : 0.1
      },
    )
    expect(closes).toHaveLength(1)
    expect(closes[0]?.buyEventId).toBe("b1")
    expect(closes[0]?.amountRaw).toBe("40")
    expect(closes[0]?.realizedReturn).toBe(0.5)
  })

  it("settles wallet buy→sell with bars", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-fifo-w-"))
    const layout = archiveLayout(root)
    mkdirSync(layout.outcomes, { recursive: true })
    writeFileSync(join(layout.outcomes, "wallet-buy-run-1.json"), `${JSON.stringify({
      schema: 1,
      runId: "run-1",
      outcomes: [
        {
          schema: 1,
          eventId: "wb_buy",
          walletId: "solana:w1",
          chain: "solana",
          tokenAddress: TOKEN,
          boughtAt: "2026-07-01T00:00:00.000Z",
          side: "buy",
          finalized: true,
          removed: false,
          priceable: true,
          rug: false,
          tokenAmountRaw: "100",
        },
        {
          schema: 1,
          eventId: "wb_sell",
          walletId: "solana:w1",
          chain: "solana",
          tokenAddress: TOKEN,
          boughtAt: "2026-07-01T12:00:00.000Z",
          side: "sell",
          finalized: true,
          removed: false,
          priceable: true,
          rug: false,
          tokenAmountRaw: "100",
        },
      ],
    }, null, 2)}\n`)

    const bars: PriceBar[] = [
      { ts: "2026-07-01T00:05:00.000Z", open: 10, finalized: true },
      { ts: "2026-07-01T12:05:00.000Z", open: 15, finalized: true },
    ]
    const report = await runSettleWalletCopyTrades({
      layout,
      nowIso: "2026-07-02T00:00:00.000Z",
      loadBars: () => bars,
    })
    expect(report.priced).toBeGreaterThanOrEqual(1)
    const body = JSON.parse(readFileSync(join(layout.outcomes, "wallet-buy-run-1.json"), "utf8"))
    const buy = body.outcomes.find((o: { eventId: string }) => o.eventId === "wb_buy")
    expect(buy.realizedReturn).toBeCloseTo(0.5)
  })

  it("settles fomo feed buy→sell and writes trader scores (not wallets.json)", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-fifo-f-"))
    const layout = archiveLayout(root)
    const agentRoot = join(root, "agent")
    mkdirSync(join(agentRoot, "state"), { recursive: true })
    mkdirSync(layout.outcomes, { recursive: true })
    writeFileSync(join(layout.outcomes, "fomo-trade-run-1.json"), `${JSON.stringify({
      schema: 1,
      runId: "run-1",
      outcomes: [
        {
          schema: 1,
          eventId: "ft_buy1",
          handle: "alice",
          chain: "solana",
          tokenAddress: TOKEN,
          side: "buy",
          tradedAt: "2026-07-01T00:00:00.000Z",
        },
        {
          schema: 1,
          eventId: "ft_sell1",
          handle: "alice",
          chain: "solana",
          tokenAddress: TOKEN,
          side: "sell",
          tradedAt: "2026-07-01T06:00:00.000Z",
        },
      ],
    }, null, 2)}\n`)

    const bars: PriceBar[] = [
      { ts: "2026-07-01T00:05:00.000Z", open: 10, finalized: true },
      { ts: "2026-07-01T06:05:00.000Z", open: 13, finalized: true },
    ]
    const report = await runSettleFomoCopyTrades({
      layout,
      nowIso: "2026-07-02T00:00:00.000Z",
      agentRoot,
      loadBars: () => bars,
      scoreCutoffHours: 0,
    })
    expect(report.priced).toBeGreaterThanOrEqual(1)
    expect(report.tradersScored).toBe(1)
    const store = new StateStore(join(agentRoot, "state"))
    expect(store.loadFomoTraderScores().traders[0]?.handle).toBe("alice")
    expect(store.loadWallets().wallets).toHaveLength(0)
  })
})

describe("solana swap-sell extraction", () => {
  it("requires token decrease plus quote gain", () => {
    const sells = extractSolanaVerifiedSellsFromTransaction({
      slot: 10,
      blockTime: 1_700_000_000,
      meta: {
        err: null,
        preBalances: [900_000_000],
        postBalances: [1_000_000_000],
        preTokenBalances: [{
          mint: TOKEN,
          owner: BUYER,
          uiTokenAmount: { amount: "1000" },
        }],
        postTokenBalances: [{
          mint: TOKEN,
          owner: BUYER,
          uiTokenAmount: { amount: "200" },
        }],
      },
      transaction: {
        signatures: ["sig-sell"],
        message: { accountKeys: [BUYER] },
      },
    }, TOKEN, { acceptNative: true, allowlist: [] })
    expect(sells).toHaveLength(1)
    expect(sells[0]?.classification).toBe("swap-sell")
    expect(eligibleWalletTrades(sells)).toHaveLength(1)
  })
})
