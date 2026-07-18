import { describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, mkdirSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SnapshotWriter } from "../../src/lib/snapshot.js"
import { StateStore } from "../../src/lib/state.js"
import { collectWatchlistScan } from "../../src/orchestrator/watchlist-collect.js"

const NOW = "2026-07-18T12:00:00.000Z"
const IDENTITY = {
  chain: "solana" as const,
  tokenAddress: "So11111111111111111111111111111111111111112",
  pairAddress: "So11111111111111111111111111111111111111112",
  symbolDisplay: "SOL",
  resolution: "resolved" as const,
}

function fixtureRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  mkdirSync(join(root, "state"), { recursive: true })
  return realpathSync(root)
}

describe("watchlist scan collection", () => {
  it("skips an empty watchlist without fetching", async () => {
    const root = fixtureRoot("tc-watchlist-empty-")
    const state = new StateStore(join(root, "state"))
    await state.saveWatchlist({ schema: 1, entries: [] })
    let fetches = 0

    const result = await collectWatchlistScan({
      runId: "watchlist-empty-1",
      writer: new SnapshotWriter(root),
      fetchedAt: NOW,
      agentRoot: root,
      fetcher: async () => {
        fetches += 1
        return new Response("{}", { status: 200 })
      },
    })

    expect(fetches).toBe(0)
    expect(result).toMatchObject({
      collectionStatus: "skipped",
      skipAgent: true,
      subjectsConsidered: 0,
    })
  })

  it("writes market and security evidence for an active bound subject", async () => {
    const root = fixtureRoot("tc-watchlist-active-")
    const state = new StateStore(join(root, "state"))
    await state.saveWatchlist({
      schema: 1,
      entries: [{
        schema: 1,
        identity: IDENTITY,
        status: "tracking",
        addedAt: NOW,
        updatedAt: NOW,
      }],
    })
    const before = state.loadWatchlist()
    const fetcher: typeof fetch = async (input) => {
      if (String(input).includes("api.dexscreener.com")) {
        return new Response(JSON.stringify({
          pairs: [{
            chainId: "solana",
            pairAddress: IDENTITY.pairAddress,
            baseToken: { address: IDENTITY.tokenAddress, symbol: "SOL", name: "Solana" },
            quoteToken: { address: "USDC", symbol: "USDC", name: "USD Coin" },
            liquidity: { usd: 1_000_000 },
            txns: { h24: { buys: 20, sells: 20 } },
            url: "https://dexscreener.com/solana/sol",
          }],
        }), { status: 200, headers: { "content-type": "application/json" } })
      }
      return new Response("{}", { status: 500, headers: { "content-type": "application/json" } })
    }

    const result = await collectWatchlistScan({
      runId: "watchlist-active-1",
      writer: new SnapshotWriter(root),
      fetchedAt: NOW,
      agentRoot: root,
      fetcher,
      twitterScrape: async () => {
        throw new Error("fixture social failure")
      },
      farcasterSearch: async () => {
        throw new Error("fixture social failure")
      },
    })

    expect(result.collectionStatus).toBe("completed")
    expect(result.skipAgent).toBe(false)
    expect(result.subjectsWithUsableEvidence).toBe(1)
    expect(result.collectionStatus).not.toBe("unavailable")
    expect(existsSync(join(root, "inbox", "watchlist-active-1", "market-dex.json"))).toBe(true)
    expect(existsSync(join(root, "inbox", "watchlist-active-1", "security-gate.json"))).toBe(true)
    expect(state.loadWatchlist()).toEqual(before)
  })

  it("journals a degraded run and skips the agent when no subject yields usable market evidence", async () => {
    const root = fixtureRoot("tc-watchlist-degraded-")
    const state = new StateStore(join(root, "state"))
    await state.saveWatchlist({
      schema: 1,
      entries: [{
        schema: 1,
        identity: IDENTITY,
        status: "tracking",
        addedAt: NOW,
        updatedAt: NOW,
      }],
    })
    const fetcher: typeof fetch = async (input) => {
      if (String(input).includes("api.dexscreener.com")) {
        return new Response(JSON.stringify({ pairs: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response("{}", { status: 500, headers: { "content-type": "application/json" } })
    }

    const result = await collectWatchlistScan({
      runId: "watchlist-degraded-1",
      writer: new SnapshotWriter(root),
      fetchedAt: NOW,
      agentRoot: root,
      fetcher,
      twitterScrape: async () => { throw new Error("fixture social failure") },
      farcasterSearch: async () => { throw new Error("fixture social failure") },
    })

    expect(result.subjectsConsidered).toBe(1)
    expect(result.subjectsWithUsableEvidence).toBe(0)
    expect(result.collectionStatus).toBe("degraded")
    expect(result.skipAgent).toBe(true)
    expect(result.snapshotNames).toContain("watchlist-collection-status")
    expect(existsSync(join(root, "inbox", "watchlist-degraded-1", "watchlist-collection-status.json"))).toBe(true)
  })
})
