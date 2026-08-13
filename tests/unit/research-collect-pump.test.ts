import { describe, expect, it, vi } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SnapshotWriter } from "../../src/lib/snapshot.js"
import { collectResearchDossier } from "../../src/orchestrator/research-collect.js"
import type { CanonicalIdentity } from "../../src/contracts/schemas.js"
import type { MarketPair } from "../../src/collectors/market/providers.js"

const IDENTITY: CanonicalIdentity = {
  chain: "solana",
  tokenAddress: "EN2nnxrg8uUi6x2sJkzNPd2eT6rB9rdSoQNNaENA4RZA",
  pairAddress: "So11111111111111111111111111111111111111112",
  symbolDisplay: "FOO",
  resolution: "resolved",
}

const NOW = "2026-08-13T12:00:00.000Z"

const PAIR: MarketPair = {
  chainId: "solana",
  pairAddress: IDENTITY.pairAddress,
  baseToken: { address: IDENTITY.tokenAddress, symbol: "FOO", name: "Foo" },
  quoteToken: {
    address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    symbol: "USDC",
    name: "USD Coin",
  },
  priceUsd: 1,
  liquidityUsd: 10_000,
  volume24hUsd: 1_000,
  fdv: 20_000,
  buys24h: 10,
  sells24h: 5,
  url: "https://dexscreener.com/solana/pair",
}

function mockFetcher(): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify({}), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch
}

describe("research collect pump origin", () => {
  it("writes pump-token-context only for pump enqueue when a session exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "pump-research-ctx-"))
    const home = join(root, "home")
    mkdirSync(join(home, ".trenchcoat", "pump-profile"), { recursive: true })
    writeFileSync(
      join(home, ".trenchcoat", "config.json"),
      `${readFileSync(join(process.cwd(), "config/seed.example.json"), "utf8")}\n`,
    )
    writeFileSync(join(home, ".trenchcoat", "pump-profile", "storage-state.json"), `${JSON.stringify({
      cookies: [{ name: "privy-token", value: "session-token-value" }],
      origins: [],
    })}\n`)
    const prevHome = process.env["HOME"]
    process.env["HOME"] = home
    mkdirSync(join(root, "agent"), { recursive: true })
    try {
      const writer = new SnapshotWriter(join(root, "agent"))
      const dossier = await collectResearchDossier({
        writer,
        runId: "research-pump-1",
        subject: `solana:${IDENTITY.tokenAddress}`,
        identity: IDENTITY,
        fetchedAt: NOW,
        enqueuedBy: "pump:top",
        pairs: [PAIR],
        fetcher: mockFetcher(),
        twitterScrape: async () => ({
          bundles: [],
          challenged: false,
          posts: [],
          popularity: {
            status: "ok",
            postCount: 0,
            uniqueAuthors: 0,
            recentPostCount: 0,
            recentWindowHours: 48,
            queriesAttempted: 0,
            queriesSucceeded: 0,
            challenged: false,
            engagement: {
              postsWithLikes: 0,
              postsWithViews: 0,
              totalLikesKnown: 0,
              totalViewsKnown: 0,
              totalRepliesKnown: 0,
              totalRepostsKnown: 0,
              medianLikesKnown: 0,
              medianViewsKnown: 0,
            },
            sampleNote: "none",
          },
        }),
      })
      expect(dossier.snapshotNames).toContain("pump-token-context")
      expect(existsSync(join(root, "agent", "inbox", "research-pump-1", "pump-token-context.json"))).toBe(true)
    } finally {
      if (prevHome === undefined) delete process.env["HOME"]
      else process.env["HOME"] = prevHome
    }
  })

  it("does not call Pump for non-pump origins", async () => {
    const root = mkdtempSync(join(tmpdir(), "pump-research-other-"))
    mkdirSync(join(root, "agent"), { recursive: true })
    const writer = new SnapshotWriter(join(root, "agent"))
    const dossier = await collectResearchDossier({
      writer,
      runId: "research-other-1",
      subject: `solana:${IDENTITY.tokenAddress}`,
      identity: IDENTITY,
      fetchedAt: NOW,
      enqueuedBy: "list-scan",
      pairs: [PAIR],
      fetcher: mockFetcher(),
      twitterScrape: async () => ({
        bundles: [],
        challenged: false,
        posts: [],
        popularity: {
          status: "ok",
          postCount: 0,
          uniqueAuthors: 0,
          recentPostCount: 0,
          recentWindowHours: 48,
          queriesAttempted: 0,
          queriesSucceeded: 0,
          challenged: false,
          engagement: {
            postsWithLikes: 0,
            postsWithViews: 0,
            totalLikesKnown: 0,
            totalViewsKnown: 0,
            totalRepliesKnown: 0,
            totalRepostsKnown: 0,
            medianLikesKnown: 0,
            medianViewsKnown: 0,
          },
          sampleNote: "none",
        },
      }),
    })
    expect(dossier.snapshotNames.includes("pump-token-context")).toBe(false)
  })
})
