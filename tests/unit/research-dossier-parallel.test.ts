import { describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SnapshotWriter } from "../../src/lib/snapshot.js"
import {
  collectResearchDossier,
  writeMarketSnapshots,
  type ResearchDossierMarket,
} from "../../src/orchestrator/research-collect.js"
import type { CanonicalIdentity } from "../../src/contracts/schemas.js"
import type { MarketPair } from "../../src/collectors/market/providers.js"
import type { ResearchTwitterScrapeResult } from "../../src/collectors/twitter/scrape.js"
import { observationFromDossier } from "../../src/discord/observation.js"

const IDENTITY: CanonicalIdentity = {
  chain: "solana",
  tokenAddress: "So11111111111111111111111111111111111111112",
  pairAddress: "Pair111111111111111111111111111111111111111",
  symbolDisplay: "SOL",
  resolution: "resolved",
}

const NOW = "2026-07-19T15:00:00.000Z"

const PAIR: MarketPair = {
  chainId: "solana",
  pairAddress: IDENTITY.pairAddress,
  baseToken: {
    address: IDENTITY.tokenAddress,
    symbol: "SOL",
    name: "Wrapped SOL",
  },
  quoteToken: {
    address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    symbol: "USDC",
    name: "USD Coin",
  },
  priceUsd: 150,
  liquidityUsd: 1_000_000,
  volume24hUsd: 50_000,
  fdv: 2_000_000,
  buys24h: 100,
  sells24h: 80,
  url: "https://dexscreener.com/solana/pair",
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function fakeTwitter(delayMs: number): () => Promise<ResearchTwitterScrapeResult> {
  return async () => {
    await delay(delayMs)
    return {
      bundles: [],
      challenged: false,
      posts: [{
        id: "1",
        author: "alpha",
        text: "SOL note",
        url: "https://x.com/alpha/status/1",
        timestamp: "2026-07-19T14:00:00.000Z",
        provenance: "twitter:@alpha",
        engagement: { likes: 5, views: 100, replies: 1, reposts: 0 },
      }],
      popularity: {
        status: "ok",
        postCount: 1,
        uniqueAuthors: 1,
        recentPostCount: 1,
        recentWindowHours: 48,
        queriesAttempted: 1,
        queriesSucceeded: 1,
        challenged: false,
        engagement: {
          postsWithLikes: 1,
          postsWithViews: 1,
          totalLikesKnown: 5,
          totalViewsKnown: 100,
          totalRepliesKnown: 1,
          totalRepostsKnown: 0,
          medianLikesKnown: 5,
          medianViewsKnown: 100,
        },
        sampleNote: "bounded",
      },
    }
  }
}

describe("research dossier parallel collection", () => {
  it("reuses carried pairs and overlaps market/security with X", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-dossier-par-"))
    try {
      const writer = new SnapshotWriter(root)
      let dexCalls = 0
      let securityStarted = 0
      let securityEnded = 0
      let twitterStarted = 0
      let twitterEnded = 0
      const fetcher = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes("dexscreener")) {
          dexCalls += 1
          return new Response(JSON.stringify({ pairs: [PAIR] }), { status: 200 })
        }
        if (!securityStarted) securityStarted = Date.now()
        await delay(80)
        securityEnded = Date.now()
        return new Response(JSON.stringify({}), { status: 200 })
      }) as unknown as typeof fetch

      const twitterScrape = async () => {
        twitterStarted = Date.now()
        const result = await fakeTwitter(80)()
        twitterEnded = Date.now()
        return result
      }

      const started = Date.now()
      const dossier = await collectResearchDossier({
        writer,
        runId: "research-par-1",
        subject: `solana:${IDENTITY.tokenAddress}`,
        identity: IDENTITY,
        fetchedAt: NOW,
        pairs: [PAIR],
        fetcher,
        twitterScrape,
      })
      const elapsed = Date.now() - started

      expect(dexCalls).toBe(0)
      expect(dossier.snapshotNames[0]).toBe("meta")
      expect(dossier.snapshotNames).toEqual([
        "meta",
        "market-dex",
        "security-gate",
        "twitter-token-search",
        "twitter-popularity",
      ])
      expect(dossier.market?.priceUsd).toBe(150)
      expect(dossier.twitter?.postCount).toBe(1)
      expect(dossier.security.status).toMatch(/pass|pending|hard-fail|unsupported-chain/)
      expect(securityStarted).toBeGreaterThan(0)
      expect(twitterStarted).toBeGreaterThan(0)
      // Branches must overlap: each starts before the other finishes
      expect(twitterStarted).toBeLessThan(securityEnded)
      expect(securityStarted).toBeLessThan(twitterEnded)
      // Serial would be ~160ms+ of waits alone; allow scheduler jitter
      expect(elapsed).toBeLessThan(
        (securityEnded - securityStarted) + (twitterEnded - twitterStarted) + 50,
      )

      const market = JSON.parse(
        readFileSync(join(root, "inbox", "research-par-1", "market-dex.json"), "utf8"),
      ) as { items: Array<{ text: string }> }
      expect(market.items[0]?.text).toContain("priceUsd=150")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("keeps fail-soft twitter and still writes market snapshots", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-dossier-soft-"))
    try {
      const writer = new SnapshotWriter(root)
      const fetcher = vi.fn(async () => {
        await delay(10)
        return new Response(JSON.stringify({}), { status: 200 })
      }) as unknown as typeof fetch

      const dossier = await collectResearchDossier({
        writer,
        runId: "research-soft-1",
        subject: `solana:${IDENTITY.tokenAddress}`,
        identity: IDENTITY,
        fetchedAt: NOW,
        pairs: [PAIR],
        fetcher,
        twitterScrape: async () => {
          throw new Error("challenge")
        },
      })

      expect(dossier.snapshotNames).toContain("market-dex")
      expect(dossier.snapshotNames).toContain("security-gate")
      expect(dossier.snapshotNames).toContain("twitter-popularity")
      expect(dossier.twitterPopularity?.status).toBe("unavailable")
      expect(existsSync(join(root, "inbox", "research-soft-1", "market-dex.json"))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("builds a Discord baseline matching dossier market/security/X", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-dossier-base-"))
    try {
      const writer = new SnapshotWriter(root)
      const fetcher = vi.fn(async () => (
        new Response(JSON.stringify({}), { status: 200 })
      )) as unknown as typeof fetch

      const dossier = await collectResearchDossier({
        writer,
        runId: "research-base-1",
        subject: `solana:${IDENTITY.tokenAddress}`,
        identity: IDENTITY,
        fetchedAt: NOW,
        pairs: [PAIR],
        fetcher,
        twitterScrape: fakeTwitter(0),
      })

      const baseline = observationFromDossier({
        ...(dossier.market ? { market: dossier.market } : {}),
        security: dossier.security,
        ...(dossier.twitter ? { twitter: dossier.twitter } : {}),
      }, NOW)

      expect(dossier.market).toBeDefined()
      expect(baseline.priceUsd).toBe((dossier.market as ResearchDossierMarket).priceUsd)
      expect(baseline.liquidityUsd).toBe(dossier.market?.liquidityUsd)
      expect(baseline.securityStatus).toBe(dossier.security.status)
      expect(baseline.xPostCount).toBe(1)
      expect(baseline.xAuthorCount).toBe(1)
      expect(baseline.xKnownLikes).toBe(5)
      expect(baseline.observedAt).toBe(NOW)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("writeMarketSnapshots fetches security while using carried pairs", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-market-par-"))
    try {
      const writer = new SnapshotWriter(root)
      let dexCalls = 0
      let securityCalls = 0
      const fetcher = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes("dexscreener")) {
          dexCalls += 1
          return new Response(JSON.stringify({ pairs: [PAIR] }), { status: 200 })
        }
        securityCalls += 1
        await delay(50)
        return new Response(JSON.stringify({}), { status: 200 })
      }) as unknown as typeof fetch

      const result = await writeMarketSnapshots({
        writer,
        runId: "mkt-1",
        identity: IDENTITY,
        fetchedAt: NOW,
        pairs: [PAIR],
        fetcher,
      })

      expect(dexCalls).toBe(0)
      expect(securityCalls).toBeGreaterThan(0)
      expect(result.names).toEqual(["market-dex", "security-gate"])
      expect(result.marketPairCount).toBe(1)
      expect(result.market?.priceUsd).toBe(150)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
