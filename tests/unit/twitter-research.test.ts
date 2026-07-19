import { describe, expect, it } from "vitest"
import {
  parseTwitterCountLabel,
} from "../../src/collectors/twitter/session.js"
import {
  buildResearchTwitterQueries,
  summarizeTwitterPopularity,
  twitterSearchUrl,
} from "../../src/collectors/twitter/popularity.js"
import type { TwitterPost } from "../../src/collectors/twitter/session.js"
import type { CanonicalIdentity } from "../../src/contracts/schemas.js"

const IDENTITY: CanonicalIdentity = {
  chain: "solana",
  tokenAddress: "So11111111111111111111111111111111111111112",
  pairAddress: "So11111111111111111111111111111111111111112",
  symbolDisplay: "SOL",
  resolution: "resolved",
}

function post(partial: Partial<TwitterPost> & Pick<TwitterPost, "id" | "author">): TwitterPost {
  return {
    text: partial.text ?? "gm",
    url: partial.url ?? `https://x.com/${partial.author}/status/${partial.id}`,
    timestamp: partial.timestamp ?? "2026-07-17T12:00:00.000Z",
    provenance: partial.provenance ?? `twitter:@${partial.author}`,
    engagement: partial.engagement ?? {},
    ...partial,
  }
}

describe("twitter count labels", () => {
  it("parses compact labels and leaves junk unknown", () => {
    expect(parseTwitterCountLabel("1.2K")).toBe(1_200)
    expect(parseTwitterCountLabel("3M")).toBe(3_000_000)
    expect(parseTwitterCountLabel("42")).toBe(42)
    expect(parseTwitterCountLabel("")).toBeUndefined()
    expect(parseTwitterCountLabel("n/a")).toBeUndefined()
  })
})

describe("research twitter queries", () => {
  it("builds host-only address, cashtag, and symbol-chain queries", () => {
    const queries = buildResearchTwitterQueries(IDENTITY)
    expect(queries.map((q) => q.kind)).toEqual([
      "token-address",
      "symbol-cashtag",
      "symbol-chain",
    ])
    expect(queries[0]?.query).toBe(IDENTITY.tokenAddress)
    expect(queries[1]?.query).toBe("$SOL")
    expect(queries[2]?.query).toBe("SOL solana")
    const live = twitterSearchUrl(IDENTITY.tokenAddress)
    expect(live.startsWith("https://x.com/search?q=")).toBe(true)
    expect(live).toContain(encodeURIComponent(IDENTITY.tokenAddress))
    expect(live).toContain("f=live")
    const top = twitterSearchUrl(IDENTITY.tokenAddress, "top")
    expect(top).not.toContain("f=live")
  })

  it("skips unsafe symbols for cashtag/chain queries", () => {
    const queries = buildResearchTwitterQueries({
      ...IDENTITY,
      symbolDisplay: "bad symbol!",
    })
    expect(queries).toHaveLength(1)
    expect(queries[0]?.kind).toBe("token-address")
  })
})

describe("twitter popularity summary", () => {
  it("aggregates known engagement and marks missing as unknown totals", () => {
    const posts = [
      post({
        id: "1",
        author: "alpha",
        timestamp: "2026-07-17T11:00:00.000Z",
        engagement: { likes: 10, views: 100, replies: 2, reposts: 1 },
      }),
      post({
        id: "2",
        author: "beta",
        timestamp: "2026-07-17T10:00:00.000Z",
        engagement: { likes: 30 },
      }),
      post({
        id: "3",
        author: "alpha",
        timestamp: "2026-07-10T10:00:00.000Z",
        engagement: {},
      }),
    ]
    const summary = summarizeTwitterPopularity({
      posts,
      fetchedAt: "2026-07-17T12:00:00.000Z",
      recentWindowHours: 48,
      queriesAttempted: 2,
      queriesSucceeded: 2,
      challenged: false,
    })
    expect(summary.status).toBe("ok")
    expect(summary.postCount).toBe(3)
    expect(summary.uniqueAuthors).toBe(2)
    expect(summary.recentPostCount).toBe(2)
    expect(summary.engagement.totalLikesKnown).toBe(40)
    expect(summary.engagement.postsWithLikes).toBe(2)
    expect(summary.engagement.medianLikesKnown).toBe(20)
    expect(summary.engagement.totalViewsKnown).toBe(100)
    expect(summary.sampleNote).toMatch(/not platform-wide/u)
  })

  it("flags degraded and unavailable samples", () => {
    const degraded = summarizeTwitterPopularity({
      posts: [],
      fetchedAt: "2026-07-17T12:00:00.000Z",
      queriesAttempted: 2,
      queriesSucceeded: 1,
      challenged: true,
    })
    expect(degraded.status).toBe("degraded")
    expect(degraded.challenged).toBe(true)

    const unavailable = summarizeTwitterPopularity({
      posts: [],
      fetchedAt: "2026-07-17T12:00:00.000Z",
      queriesAttempted: 2,
      queriesSucceeded: 0,
      challenged: false,
      unavailableReason: "No X session",
    })
    expect(unavailable.status).toBe("unavailable")
    expect(unavailable.sampleNote).toMatch(/do not invent/u)
  })
})
