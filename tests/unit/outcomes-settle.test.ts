import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { archiveLayout } from "../../src/lib/archive.js"
import { appendSourceCallEventsFromArchiveInbox } from "../../src/orchestrator/call-log.js"
import { runOutcomesSettle } from "../../src/orchestrator/outcomes-settle.js"
import { createLiveWalletBarProvider, clearMarketBarPoolCache } from "../../src/orchestrator/market-bars.js"
import type { PriceBar } from "../../src/orchestrator/observations.js"

const TOKEN = "So11111111111111111111111111111111111111112"
const PAIR = "pool111111111111111111111111111111111111111"
const OLD = "2026-07-01T00:00:00.000Z"
const NOW = "2026-07-20T00:00:00.000Z"
const env = { ...process.env }

const bars: PriceBar[] = [
  { ts: "2026-07-01T00:05:00.000Z", open: 10, finalized: true },
  { ts: "2026-07-04T00:05:00.000Z", open: 20, finalized: true }, // >= +72h
]

describe("runOutcomesSettle", () => {
  afterEach(() => {
    process.env = { ...env }
    clearMarketBarPoolCache()
  })

  it("drives both settlers and returns per-domain counts", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-settle-all-"))
    const layout = archiveLayout(root)

    const inbox = join(root, "runs", "run-1", "inbox")
    mkdirSync(inbox, { recursive: true })
    writeFileSync(join(inbox, "tg.json"), `${JSON.stringify({
      source: "telegram",
      fetchedAt: OLD,
      trust: "untrusted-external",
      items: [{
        provenance: "telegram:alpha",
        text: `ape ${TOKEN} entry now`,
        ts: OLD,
        ageSec: 0,
        freshnessTier: "live",
      }],
    }, null, 2)}\n`)
    await appendSourceCallEventsFromArchiveInbox(layout, "run-1")

    mkdirSync(layout.outcomes, { recursive: true })
    writeFileSync(join(layout.outcomes, "wallet-buy-run-1.json"), `${JSON.stringify({
      schema: 1,
      runId: "run-1",
      outcomes: [{
        schema: 1,
        eventId: "wb_ok",
        walletId: "solana:w1",
        chain: "solana",
        tokenAddress: TOKEN,
        boughtAt: OLD,
        finalized: true,
        removed: false,
        priceable: true,
        rug: false,
      }],
    }, null, 2)}\n`)

    const report = await runOutcomesSettle({
      layout,
      nowIso: NOW,
      horizons: [72],
      sourceBars: () => bars,
      walletBars: () => bars,
    })

    expect(report.sourceCalls.complete).toBe(1)
    expect(report.sourcePeaks.written).toBeGreaterThanOrEqual(1)
    expect(report.walletBuys.complete).toBe(1)
    expect(report.walletBuys.buysUpdated).toBe(1)
    expect(report.walletCopyTrades).toBeDefined()
    expect(report.fomoCopyTrades).toBeDefined()
    expect(report.pumpCalls).toBeDefined()
  })

  it("FOMO copy-trade settle receives bars after gecko exhaustion via Solana fallback", async () => {
    process.env["SOLANATRACKER_API_KEY"] = "st-key"
    const root = mkdtempSync(join(tmpdir(), "tc-settle-fomo-fallback-"))
    const layout = archiveLayout(root)
    mkdirSync(layout.outcomes, { recursive: true })
    writeFileSync(join(layout.outcomes, "fomo-trade-run-1.json"), `${JSON.stringify({
      schema: 1,
      runId: "run-1",
      outcomes: [
        {
          schema: 1,
          eventId: "ft_buy",
          handle: "alice",
          chain: "solana",
          tokenAddress: TOKEN,
          side: "buy",
          tradedAt: "2026-07-01T00:00:00.000Z",
        },
        {
          schema: 1,
          eventId: "ft_sell",
          handle: "alice",
          chain: "solana",
          tokenAddress: TOKEN,
          side: "sell",
          tradedAt: "2026-07-01T06:00:00.000Z",
        },
      ],
    }, null, 2)}\n`)

    const buyBar = Math.floor(Date.parse("2026-07-01T00:05:00.000Z") / 1000)
    const sellBar = Math.floor(Date.parse("2026-07-01T06:05:00.000Z") / 1000)
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes("dexscreener")) {
        return new Response(JSON.stringify({
          pairs: [{
            chainId: "solana",
            pairAddress: PAIR,
            baseToken: { address: TOKEN, symbol: "SOL", name: "Sol" },
            quoteToken: { address: "quote", symbol: "USDC", name: "USDC" },
            liquidity: { usd: 1_000_000 },
            txns: { h24: { buys: 10, sells: 10 } },
            url: "https://dexscreener.com/solana/x",
          }],
        }), { status: 200, headers: { "content-type": "application/json" } })
      }
      if (url.includes("geckoterminal")) {
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "0" },
        })
      }
      if (url.includes("solanatracker")) {
        return new Response(JSON.stringify({
          ohlcv: [
            { time: buyBar, open: 10, high: 11, low: 9, close: 10.5, volume: 100 },
            { time: sellBar, open: 13, high: 14, low: 12, close: 13.5, volume: 100 },
          ],
        }), { status: 200, headers: { "content-type": "application/json" } })
      }
      throw new Error(`unexpected url ${url}`)
    }

    const walletBars = createLiveWalletBarProvider(fetcher, () => NOW)
    const report = await runOutcomesSettle({
      layout,
      nowIso: NOW,
      horizons: [72],
      walletBars,
    })

    expect(report.fomoCopyTrades.priced).toBe(1)
    expect(report.fomoCopyTrades.providerPending).toBe(0)
  })
})
