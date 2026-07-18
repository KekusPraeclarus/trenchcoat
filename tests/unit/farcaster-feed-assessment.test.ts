import { describe, expect, it } from "vitest"
import {
  assessFarcasterBundle,
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
  })

  it("collect path marks the for-you feed skipAgent when only stale casts arrive", async () => {
    const config = {
      farcaster: {
        enabled: true,
        bot_fid: 1,
        scrape_for_you: true,
        max_items_per_feed: 25,
      },
    } as unknown as TrenchcoatConfig
    const staleFetcher = async () => new Response(JSON.stringify({
      casts: [
        { hash: HASH_A, text: "old", timestamp: new Date(Date.parse(fetchedAt) - 12 * 3_600_000).toISOString(), author: { username: "alice", fid: 1 } },
        { hash: HASH_B, text: "old", timestamp: new Date(Date.parse(fetchedAt) - 14 * 3_600_000).toISOString(), author: { username: "bob", fid: 2 } },
        { hash: HASH_C, text: "old", timestamp: new Date(Date.parse(fetchedAt) - 16 * 3_600_000).toISOString(), author: { username: "carol", fid: 3 } },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } })

    const bundles = await scrapeConfiguredFarcaster(config, {
      apiKey: "test-key",
      fetcher: staleFetcher,
      fetchedAt,
    })
    const forYou = bundles.find((b) => b.assessment.target.kind === "for_you")?.assessment
    expect(forYou?.skipAgent).toBe(true)
    expect(forYou?.rejectReason).toBe("no_live_casts")
    expect(forYou?.eligibleCasts).toHaveLength(0)
  })

  it("treats future-dated timestamps as expired and rejects for-you", () => {
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
  })
})
