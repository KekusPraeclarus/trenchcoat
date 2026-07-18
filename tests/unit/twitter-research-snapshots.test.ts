import { describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, existsSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SnapshotWriter } from "../../src/lib/snapshot.js"
import { writeTwitterResearchSnapshots } from "../../src/orchestrator/research.js"
import type { CanonicalIdentity } from "../../src/contracts/schemas.js"
import type { ResearchTwitterScrapeResult } from "../../src/collectors/twitter/scrape.js"

const IDENTITY: CanonicalIdentity = {
  chain: "solana",
  tokenAddress: "So11111111111111111111111111111111111111112",
  pairAddress: "So11111111111111111111111111111111111111112",
  symbolDisplay: "SOL",
  resolution: "resolved",
}

const NOW = "2026-07-17T15:00:00.000Z"

describe("twitter research snapshot writing", () => {
  it("writes untrusted tweet + popularity snapshots from host scrape", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "tc-tw-research-")))
    const writer = new SnapshotWriter(root)
    const fakeScrape = async (): Promise<ResearchTwitterScrapeResult> => ({
      bundles: [],
      challenged: false,
      posts: [{
        id: "123",
        author: "alpha",
        text: "SOL looking strong",
        url: "https://x.com/alpha/status/123",
        timestamp: "2026-07-17T14:00:00.000Z",
        provenance: "twitter:@alpha",
        engagement: { likes: 12, views: 500, replies: 1, reposts: 2 },
      }],
      popularity: {
        status: "ok",
        postCount: 1,
        uniqueAuthors: 1,
        recentPostCount: 1,
        recentWindowHours: 48,
        queriesAttempted: 2,
        queriesSucceeded: 2,
        challenged: false,
        engagement: {
          postsWithLikes: 1,
          postsWithViews: 1,
          totalLikesKnown: 12,
          totalViewsKnown: 500,
          totalRepliesKnown: 1,
          totalRepostsKnown: 2,
          medianLikesKnown: 12,
          medianViewsKnown: 500,
        },
        sampleNote: "Sample is bounded host X search only — not platform-wide reach.",
      },
    })

    const result = await writeTwitterResearchSnapshots({
      writer,
      runId: "research-test-1",
      identity: IDENTITY,
      fetchedAt: NOW,
      maxPages: 1,
      maxPosts: 40,
      recentWindowHours: 48,
      scrape: fakeScrape,
    })

    expect(result.names).toEqual(["twitter-token-search", "twitter-popularity"])
    expect(result.popularity.postCount).toBe(1)

    const tweetsPath = join(root, "inbox", "research-test-1", "twitter-token-search.json")
    const popPath = join(root, "inbox", "research-test-1", "twitter-popularity.json")
    expect(existsSync(tweetsPath)).toBe(true)
    expect(existsSync(popPath)).toBe(true)

    const tweets = JSON.parse(readFileSync(tweetsPath, "utf8")) as {
      trust: string
      items: Array<{ provenance: string; text: string; dedupeKey?: string }>
    }
    expect(tweets.trust).toBe("untrusted-external")
    expect(tweets.items[0]?.provenance).toBe("twitter:@alpha")
    expect(tweets.items[0]?.dedupeKey).toBe("123")
    expect(tweets.items[0]?.text).toContain("likes=12")

    const pop = JSON.parse(readFileSync(popPath, "utf8")) as {
      trust: string
      items: Array<{ text: string }>
    }
    expect(pop.trust).toBe("untrusted-external")
    expect(pop.items[0]?.text).toContain('"postCount":1')
  })
})
