import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ensureArchive } from "../../src/lib/archive.js"
import { StateStore } from "../../src/lib/state.js"
import { bridgeNarrativeTickers } from "../../src/orchestrator/narrative-bridge.js"
import type { NarrativeLogEntry } from "../../src/orchestrator/narrative-log.js"

const NOW = "2026-07-18T12:00:00.000Z"
const TOKEN = "So11111111111111111111111111111111111111112"
const PAIR = "11111111111111111111111111111111"

function narrative(overrides: Partial<NarrativeLogEntry> = {}): NarrativeLogEntry {
  return {
    slug: "jimothy-season",
    title: "Jimothy season",
    firstSeen: NOW,
    lastSeen: NOW,
    evidence: ["twitter:@alice:123"],
    stage: "emerging",
    ...overrides,
  }
}

function fetcher(symbol = "JIMOTHY"): typeof fetch {
  return async () => new Response(JSON.stringify({
    pairs: [{
      chainId: "solana",
      pairAddress: PAIR,
      baseToken: { address: TOKEN, symbol, name: symbol },
      quoteToken: { address: "USDC", symbol: "USDC", name: "USD Coin" },
      liquidity: { usd: 100_000 },
      volume: { h24: 10_000 },
      txns: { h24: { buys: 10, sells: 5 } },
      url: "https://dexscreener.com/solana/test",
    }],
  }), { status: 200, headers: { "content-type": "application/json" } })
}

describe("narrative bridge", () => {
  it("enqueues a resolved ticker from a new narrative and archives a receipt", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-narrative-bridge-"))
    const agentRoot = join(root, "agent")
    const archive = await ensureArchive(join(root, "archive"))
    const report = await bridgeNarrativeTickers({
      agentRoot,
      archiveRoot: archive.root,
      runId: "narrative-bridge-1",
      nowIso: NOW,
      logBefore: [],
      logAfter: [narrative({ title: "$JIMOTHY season" })],
      fetcher: fetcher(),
    })

    const queue = new StateStore(join(agentRoot, "state")).loadResearchQueue()
    expect(report.enqueued).toBe(1)
    expect(queue.entries[0]).toMatchObject({
      subject: "JIMOTHY",
      trigger: "narrative",
      status: "pending",
      resolution: "resolved",
      chain: "solana",
      tokenAddress: TOKEN,
      pairAddress: PAIR,
      security: { status: "pending", flags: [] },
    })
    expect(queue.entries[0]?.provenance).toEqual(["narrative:jimothy-season", "twitter:@alice:123"])
    expect(existsSync(join(archive.runs, "narrative-bridge-1", "narrative-bridge.json"))).toBe(true)
  })

  it("triggers only when an existing narrative transitions to peaking", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-narrative-peaking-"))
    const agentRoot = join(root, "agent")
    const before = narrative({ stage: "emerging" })
    const after = narrative({ stage: "peaking", title: "$JIMOTHY season" })
    const report = await bridgeNarrativeTickers({
      agentRoot,
      runId: "narrative-bridge-2",
      nowIso: NOW,
      logBefore: [before],
      logAfter: [after],
      fetcher: fetcher(),
    })

    expect(report.triggerSlugs).toEqual(["jimothy-season"])
    expect(new StateStore(join(agentRoot, "state")).loadResearchQueue().entries).toHaveLength(1)
  })

  it("rejects malformed ticker fields from a new narrative", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-narrative-unchanged-"))
    const entry = narrative({ tickers: ["$", "BAD TICKER", "THE"] })
    const report = await bridgeNarrativeTickers({
      agentRoot: join(root, "agent"),
      runId: "narrative-bridge-3",
      nowIso: NOW,
      logBefore: [],
      logAfter: [entry],
      fetcher: fetcher(),
    })

    expect(report.consideredSymbols).toBe(0)
    expect(report.enqueued).toBe(0)
  })

  it("skips unchanged narratives", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-narrative-noop-"))
    const entry = narrative({ title: "$JIMOTHY season" })
    const report = await bridgeNarrativeTickers({
      agentRoot: join(root, "agent"),
      runId: "narrative-bridge-noop",
      nowIso: NOW,
      logBefore: [entry],
      logAfter: [entry],
      fetcher: fetcher(),
    })

    expect(report.triggerSlugs).toEqual([])
    expect(report.enqueued).toBe(0)
  })

  it("holds an ambiguous ticker as an ambiguous queue entry with a shortlist reason", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-narrative-ambiguous-"))
    const agentRoot = join(root, "agent")
    const rivalToken = "So11111111111111111111111111111111111111113"
    const rivalPair = "So11111111111111111111111111111111111111113"
    const ambiguousFetcher: typeof fetch = async () => new Response(JSON.stringify({
      pairs: [
        {
          chainId: "solana",
          pairAddress: PAIR,
          baseToken: { address: TOKEN, symbol: "JIMOTHY", name: "Jimothy One" },
          quoteToken: { address: "USDC", symbol: "USDC", name: "USD Coin" },
          liquidity: { usd: 100_000 },
          volume: { h24: 10_000 },
          txns: { h24: { buys: 10, sells: 5 } },
          url: "https://dexscreener.com/solana/one",
        },
        {
          chainId: "solana",
          pairAddress: rivalPair,
          baseToken: { address: rivalToken, symbol: "JIMOTHY", name: "Jimothy Two" },
          quoteToken: { address: "USDC", symbol: "USDC", name: "USD Coin" },
          liquidity: { usd: 100_000 },
          volume: { h24: 10_000 },
          txns: { h24: { buys: 10, sells: 5 } },
          url: "https://dexscreener.com/solana/two",
        },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } })

    const report = await bridgeNarrativeTickers({
      agentRoot,
      runId: "narrative-bridge-ambiguous",
      nowIso: NOW,
      logBefore: [],
      logAfter: [narrative({ title: "$JIMOTHY season" })],
      fetcher: ambiguousFetcher,
    })

    expect(report.enqueued).toBe(1)
    expect(report.items[0]).toMatchObject({ symbol: "JIMOTHY", status: "ambiguous" })
    const queue = new StateStore(join(agentRoot, "state")).loadResearchQueue()
    expect(queue.entries[0]).toMatchObject({
      subject: "JIMOTHY",
      status: "ambiguous",
      resolution: "ambiguous",
    })
    expect(queue.entries[0]?.reason).toContain("shortlist=")
    expect(queue.entries[0]?.tokenAddress).toBeUndefined()
  })

  it("uses an explicit ticker field and skips active watchlist identities", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-narrative-watchlist-"))
    const agentRoot = join(root, "agent")
    const state = new StateStore(join(agentRoot, "state"))
    await state.saveWatchlist({
      schema: 1,
      entries: [{
        schema: 1,
        identity: {
          chain: "solana",
          tokenAddress: TOKEN,
          pairAddress: PAIR,
          symbolDisplay: "JIMOTHY",
          resolution: "resolved",
        },
        status: "tracking",
        addedAt: NOW,
        updatedAt: NOW,
      }],
    })
    const beforeWatchlist = readFileSync(state.watchlistPath(), "utf8")
    const report = await bridgeNarrativeTickers({
      agentRoot,
      runId: "narrative-bridge-4",
      nowIso: NOW,
      logBefore: [],
      logAfter: [narrative({ title: "independent narrative", tickers: ["Jimothy"] })],
      fetcher: fetcher(),
    })

    expect(report.skippedWatchlist).toBe(1)
    expect(state.loadResearchQueue().entries).toHaveLength(0)
    expect(readFileSync(state.watchlistPath(), "utf8")).toBe(beforeWatchlist)
  })
})
