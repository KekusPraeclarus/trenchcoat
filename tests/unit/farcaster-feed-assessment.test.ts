import { describe, expect, it } from "vitest"
import {
  assessFarcasterBundle,
  buildFarcasterCollectionReceipt,
  castAgeSec,
  detectRepeatedTwoHashStalePattern,
  freshnessTierForAge,
  scrapeConfiguredFarcaster,
} from "../../src/collectors/farcaster/scrape.js"
import type { FarcasterCast } from "../../src/collectors/farcaster/neynar.js"
import type { TrenchcoatConfig } from "../../src/lib/config.js"

const HASH_A = "0x1111111111111111111111111111111111111111"
const HASH_B = "0x2222222222222222222222222222222222222222"
const HASH_C = "0x3333333333333333333333333333333333333333"
const HASH_D = "0x4444444444444444444444444444444444444444"

function cast(hash: string, hoursAgo: number, fetchedAt: string): FarcasterCast {
  const ts = new Date(Date.parse(fetchedAt) - hoursAgo * 3_600_000).toISOString()
  return {
    hash,
    author: "alice",
    authorFid: 1,
    text: "hello",
    timestamp: ts,
    provenance: "farcaster:@alice",
    engagement: {},
  }
}

function neynarCast(hash: string, hoursAgo: number, fetchedAt: string, author = "alice", fid = 1) {
  return {
    hash,
    text: "hello",
    timestamp: new Date(Date.parse(fetchedAt) - hoursAgo * 3_600_000).toISOString(),
    author: { username: author, fid },
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

describe("farcaster feed assessment", () => {
  const fetchedAt = "2026-07-18T12:00:00.000Z"

  it("classifies live, stale, and expired tiers", () => {
    expect(freshnessTierForAge(castAgeSec(fetchedAt, cast(HASH_A, 2, fetchedAt).timestamp))).toBe("live")
    expect(freshnessTierForAge(castAgeSec(fetchedAt, cast(HASH_A, 12, fetchedAt).timestamp))).toBe("stale")
    expect(freshnessTierForAge(castAgeSec(fetchedAt, cast(HASH_A, 30, fetchedAt).timestamp))).toBe("expired")
  })

  it("rejects for-you when no live casts", () => {
    const assessment = assessFarcasterBundle({
      target: { kind: "for_you", label: "for-you", feedKind: "for_you" },
      casts: [
        cast(HASH_A, 12, fetchedAt),
        cast(HASH_B, 20, fetchedAt),
        cast(HASH_C, 18, fetchedAt),
      ],
    }, fetchedAt)
    expect(assessment.rejected).toBe(true)
    expect(assessment.rejectReason).toBe("no_live_casts")
    expect(assessment.eligibleCasts).toHaveLength(0)
    expect(assessment.skipAgent).toBe(true)
    expect(assessment.analysisEligible).toBe(false)
    expect(assessment.engagementEligible).toBe(false)
  })

  it("rejects for-you on repeated-two-hash stale pattern", () => {
    const casts = [
      cast(HASH_A, 10, fetchedAt),
      cast(HASH_B, 11, fetchedAt),
      cast(HASH_A, 12, fetchedAt),
      cast(HASH_B, 13, fetchedAt),
    ]
    expect(detectRepeatedTwoHashStalePattern(casts, fetchedAt)).toBe(true)
    const assessment = assessFarcasterBundle({
      target: { kind: "for_you", label: "for-you", feedKind: "for_you" },
      casts,
    }, fetchedAt)
    expect(assessment.rejectReason).toBe("repeated_two_hash_stale")
    expect(assessment.skipAgent).toBe(true)
    expect(assessment.engagementEligible).toBe(false)
  })

  it("drops expired casts from eligible evidence but keeps live FYP", () => {
    const assessment = assessFarcasterBundle({
      target: { kind: "for_you", label: "for-you", feedKind: "for_you" },
      casts: [
        cast(HASH_A, 2, fetchedAt),
        cast(HASH_B, 30, fetchedAt),
        cast(HASH_C, 4, fetchedAt),
      ],
    }, fetchedAt)
    expect(assessment.rejected).toBe(false)
    expect(assessment.eligibleCasts.map((c) => c.hash)).toEqual([HASH_A, HASH_C])
    expect(assessment.counts.expired).toBe(1)
    expect(assessment.engagementEligible).toBe(true)
  })

  it("does not reject channel feeds for stale-only content", () => {
    const assessment = assessFarcasterBundle({
      target: {
        kind: "channel",
        label: "operator-channel-1",
        channelId: "base",
        feedKind: "channel",
      },
      casts: [cast(HASH_A, 12, fetchedAt)],
    }, fetchedAt)
    expect(assessment.rejected).toBe(false)
    expect(assessment.eligibleCasts).toHaveLength(1)
    expect(assessment.analysisEligible).toBe(true)
    expect(assessment.engagementEligible).toBe(false)
  })

  it("fetches one trending fallback when for-you is stale-only", async () => {
    const config = {
      farcaster: {
        enabled: true,
        bot_fid: 1,
        scrape_for_you: true,
        max_items_per_feed: 25,
      },
    } as unknown as TrenchcoatConfig
    let trendingCalls = 0
    const fetcher = async (input: RequestInfo | URL) => {
      const href = String(input)
      if (href.includes("/feed/for_you")) {
        return jsonResponse({
          casts: [
            neynarCast(HASH_A, 12, fetchedAt, "alice", 1),
            neynarCast(HASH_B, 14, fetchedAt, "bob", 2),
            neynarCast(HASH_C, 16, fetchedAt, "carol", 3),
          ],
        })
      }
      if (href.includes("/feed/trending")) {
        trendingCalls += 1
        expect(href).not.toMatch(/cursor=/u)
        expect(href).not.toMatch(/cache|bust|refresh/iu)
        // Neynar trending max is 10; clamp even when max_items_per_feed is 25
        expect(href).toMatch(/[?&]limit=10(?:&|$)/u)
        return jsonResponse({
          casts: [neynarCast(HASH_D, 1, fetchedAt, "dave", 4)],
        })
      }
      if (href.includes("feed_type=following")) {
        return jsonResponse({ casts: [] })
      }
      throw new Error(`unexpected url ${href}`)
    }

    const bundles = await scrapeConfiguredFarcaster(config, {
      apiKey: "test-key",
      fetcher,
      fetchedAt,
    })
    expect(trendingCalls).toBe(1)
    const forYou = bundles.find((b) => b.assessment.target.kind === "for_you")?.assessment
    const fallback = bundles.find((b) => b.assessment.target.kind === "trending")?.assessment
    expect(forYou?.skipAgent).toBe(true)
    expect(forYou?.rejectReason).toBe("no_live_casts")
    expect(forYou?.engagementEligible).toBe(false)
    expect(fallback?.target.fallbackOf).toBe("for_you")
    expect(fallback?.analysisEligible).toBe(true)
    expect(fallback?.engagementEligible).toBe(false)
    expect(fallback?.eligibleCasts.map((c) => c.hash)).toEqual([HASH_D])

    const receipt = buildFarcasterCollectionReceipt(bundles.map((b) => b.assessment))
    expect(receipt.fallbackUsed).toBe(true)
    expect(receipt.skipAgent).toBe(false)
    expect(receipt.engagementDisabled).toBe(true)
    expect(receipt.usableEvidenceCount).toBe(1)
  })

  it("skips agent when every feed is unusable after fallback", async () => {
    const config = {
      farcaster: {
        enabled: true,
        bot_fid: 1,
        scrape_for_you: true,
        max_items_per_feed: 25,
      },
    } as unknown as TrenchcoatConfig
    const fetcher = async (input: RequestInfo | URL) => {
      const href = String(input)
      if (href.includes("/feed/for_you") || href.includes("/feed/trending")) {
        return jsonResponse({
          casts: [
            neynarCast(HASH_A, 30, fetchedAt),
            neynarCast(HASH_B, 31, fetchedAt, "bob", 2),
          ],
        })
      }
      if (href.includes("feed_type=following")) {
        return jsonResponse({ casts: [] })
      }
      throw new Error(`unexpected url ${href}`)
    }
    const bundles = await scrapeConfiguredFarcaster(config, {
      apiKey: "test-key",
      fetcher,
      fetchedAt,
    })
    const receipt = buildFarcasterCollectionReceipt(bundles.map((b) => b.assessment))
    expect(receipt.fallbackUsed).toBe(true)
    expect(receipt.usableEvidenceCount).toBe(0)
    expect(receipt.skipAgent).toBe(true)
    expect(receipt.engagementDisabled).toBe(true)
  })

  it("treats future-dated timestamps as expired and still attempts one trending fallback", async () => {
    const futureCasts: FarcasterCast[] = [
      {
        hash: HASH_A,
        author: "akimaru",
        authorFid: 1,
        text: "Hello world!!",
        timestamp: "2076-05-04T16:31:28.000Z",
        provenance: "farcaster:@akimaru",
        engagement: {},
      },
      {
        hash: HASH_B,
        author: "greg",
        authorFid: 2,
        text: "time travel",
        timestamp: "2061-09-12T02:43:58.000Z",
        provenance: "farcaster:@greg",
        engagement: {},
      },
    ]
    expect(freshnessTierForAge(castAgeSec(fetchedAt, futureCasts[0]!.timestamp))).toBe("expired")
    expect(detectRepeatedTwoHashStalePattern(futureCasts, fetchedAt)).toBe(true)
    const assessment = assessFarcasterBundle({
      target: { kind: "for_you", label: "for-you", feedKind: "for_you" },
      casts: futureCasts,
    }, fetchedAt)
    expect(assessment.rejected).toBe(true)
    expect(assessment.skipAgent).toBe(true)
    expect(assessment.eligibleCasts).toHaveLength(0)
    expect(assessment.counts.expired).toBe(2)
    expect(assessment.counts.live).toBe(0)

    const config = {
      farcaster: {
        enabled: true,
        bot_fid: 1,
        scrape_for_you: true,
        max_items_per_feed: 25,
      },
    } as unknown as TrenchcoatConfig
    let trendingCalls = 0
    const fetcher = async (input: RequestInfo | URL) => {
      const href = String(input)
      if (href.includes("/feed/for_you")) {
        return jsonResponse({
          casts: [
            {
              hash: HASH_A,
              text: "Hello world!!",
              timestamp: "2076-05-04T16:31:28.000Z",
              author: { username: "akimaru", fid: 1 },
            },
            {
              hash: HASH_B,
              text: "time travel",
              timestamp: "2061-09-12T02:43:58.000Z",
              author: { username: "greg", fid: 2 },
            },
          ],
        })
      }
      if (href.includes("/feed/trending")) {
        trendingCalls += 1
        return jsonResponse({ casts: [neynarCast(HASH_C, 2, fetchedAt, "live", 3)] })
      }
      if (href.includes("feed_type=following")) {
        return jsonResponse({ casts: [] })
      }
      throw new Error(`unexpected url ${href}`)
    }
    const bundles = await scrapeConfiguredFarcaster(config, {
      apiKey: "test-key",
      fetcher,
      fetchedAt,
    })
    expect(trendingCalls).toBe(1)
    const receipt = buildFarcasterCollectionReceipt(bundles.map((b) => b.assessment))
    expect(receipt.fallbackUsed).toBe(true)
    expect(receipt.engagementDisabled).toBe(true)
    expect(receipt.skipAgent).toBe(false)
    expect(
      bundles.find((b) => b.assessment.target.kind === "for_you")?.assessment.engagementEligible,
    ).toBe(false)
  })

  it("never marks trending fallback casts as engagement-eligible", () => {
    const assessment = assessFarcasterBundle({
      target: {
        kind: "trending",
        label: "trending-fallback",
        feedKind: "trending",
        fallbackOf: "for_you",
      },
      casts: [cast(HASH_A, 1, fetchedAt)],
    }, fetchedAt)
    expect(assessment.analysisEligible).toBe(true)
    expect(assessment.engagementEligible).toBe(false)
  })
})
