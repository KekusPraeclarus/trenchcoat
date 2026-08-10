import { afterEach, describe, expect, it, beforeEach } from "vitest"
import {
  clearMarketBarPoolCache,
  createLiveSourceBarProvider,
  createLiveWalletBarProvider,
} from "../../src/orchestrator/market-bars.js"
import type { SourceCallEvent, WalletBuyOutcome } from "../../src/contracts/schemas.js"

const TOKEN = "So11111111111111111111111111111111111111112"
const PAIR = "pool111111111111111111111111111111111111111"
const env = { ...process.env }

function sourceEvent(): SourceCallEvent {
  return {
    schema: 1,
    eventId: "ev1",
    sourceId: "src1",
    provenance: "x:a",
    rawAddress: TOKEN,
    chainHint: "solana",
    mentionedAt: "2026-07-01T00:00:00.000Z",
    parserVersion: 1,
    rawItemHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    pairAddress: PAIR,
  }
}

function walletBuy(): WalletBuyOutcome {
  return {
    schema: 1,
    eventId: "wb1",
    walletId: "w1",
    chain: "solana",
    tokenAddress: TOKEN,
    boughtAt: "2026-07-01T00:00:00.000Z",
    finalized: true,
    removed: false,
    priceable: true,
    rug: false,
  }
}

describe("live market bar providers", () => {
  beforeEach(() => {
    clearMarketBarPoolCache()
    process.env = { ...env }
    // Ambient operator keys (.env) enable the OHLCV fallback chain, whose real
    // retry backoff makes failure-path tests slow and timing-dependent.
    delete process.env["SOLANATRACKER_API_KEY"]
    delete process.env["BIRDEYE_API_KEY"]
  })

  afterEach(() => {
    process.env = { ...env }
  })

  // Real retry backoff sleeps make provider failure-path tests slow
  it("returns empty bars when upstream fails (never invents prices)", async () => {
    const fetcher = async () => new Response("nope", { status: 500 })
    const sourceBars = createLiveSourceBarProvider(fetcher, () => "2026-07-20T00:00:00.000Z")
    const walletBars = createLiveWalletBarProvider(fetcher, () => "2026-07-20T00:00:00.000Z")
    expect(await sourceBars(sourceEvent(), 72)).toEqual([])
    expect(await walletBars(walletBuy(), 72)).toEqual([])
  }, 20_000)

  it("maps closed gecko candles into finalized price bars", async () => {
    const asOf = Math.floor(Date.parse("2026-07-20T00:00:00.000Z") / 1000)
    const aligned = asOf - (asOf % 300) - 300
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
      // Gecko OHLCV list: [ts, o, h, l, c, v]
      return new Response(JSON.stringify({
        data: {
          attributes: {
            ohlcv_list: [
              [aligned - 600, 1, 1.1, 0.9, 1.05, 100],
              [aligned - 300, 1.05, 1.2, 1.0, 1.1, 100],
              [aligned, 1.1, 1.3, 1.05, 1.2, 100],
            ],
          },
        },
      }), { status: 200, headers: { "content-type": "application/json" } })
    }

    const sourceBars = createLiveSourceBarProvider(fetcher, () => "2026-07-20T00:00:00.000Z")
    const bars = await sourceBars(sourceEvent(), 72)
    expect(bars?.length).toBeGreaterThan(0)
    expect(bars!.every((b) => b.finalized && b.open > 0)).toBe(true)
  })

  it("recovers Solana OHLCV via SolanaTracker when GeckoTerminal returns 429", async () => {
    process.env["SOLANATRACKER_API_KEY"] = "st-key"
    const asOf = Math.floor(Date.parse("2026-07-20T00:00:00.000Z") / 1000)
    const aligned = asOf - (asOf % 300) - 300
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
            { time: aligned - 300, open: 1, high: 1.1, low: 0.9, close: 1.05, volume: 100 },
            { time: aligned, open: 1.05, high: 1.2, low: 1.0, close: 1.1, volume: 100 },
          ],
        }), { status: 200, headers: { "content-type": "application/json" } })
      }
      throw new Error(`unexpected url ${url}`)
    }

    const walletBars = createLiveWalletBarProvider(fetcher, () => "2026-07-20T00:00:00.000Z")
    const bars = await walletBars(walletBuy(), 72)
    expect(bars?.length).toBeGreaterThan(0)
    expect(bars!.every((b) => b.finalized && b.open > 0)).toBe(true)
  }, 20_000)
})
