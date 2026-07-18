import { describe, expect, it } from "vitest"
import { parseNeynarCast, fetchNeynarFeed } from "../../src/collectors/farcaster/neynar.js"
import {
  isForbiddenFcWritePath,
  isAllowedFcWriteOp,
  executeFcEngagementActions,
} from "../../src/collectors/farcaster/engagement.js"
import {
  applyFcEngagementChoices,
  parseFcEngagementProposal,
  fcLikesInWindow,
} from "../../src/social/fc-engagement.js"
import {
  registerFcDiscoveryCandidates,
  computeFollowDiff,
  confineFollowTargets,
  reviewFcSourceLifecycle,
} from "../../src/sources/fc-lifecycle.js"
import type { FcEngagementFile, SourcePerformance } from "../../src/contracts/schemas.js"
import type { EngagementCaps } from "../../src/social/x-engagement.js"

const caps: EngagementCaps = {
  enabled: true,
  likes_per_window: 2,
  like_window_minutes: 10,
}

function emptyFcState(): FcEngagementFile {
  return {
    schema: 1,
    likedCastHashes: [],
    lastLikedAt: {},
    pendingActionIds: [],
    decisions: [],
    receipts: [],
    daily: { day: "2026-07-17", likes: 0 },
  }
}

const SAMPLE_HASH = "0x1111111111111111111111111111111111111111"
const OTHER_HASH = "0x2222222222222222222222222222222222222222"

describe("neynar cast parsing", () => {
  it("parses engagement and provenance", () => {
    const cast = parseNeynarCast({
      hash: SAMPLE_HASH,
      text: "hello",
      timestamp: "2026-07-17T00:00:00.000Z",
      author: { username: "alice", fid: 42 },
      reactions: { likes_count: 3, recasts_count: 1 },
      replies: { count: 2 },
    })
    expect(cast.author).toBe("alice")
    expect(cast.authorFid).toBe(42)
    expect(cast.provenance).toBe("farcaster:@alice")
    expect(cast.engagement.likes).toBe(3)
  })

  it("skips casts with incomplete authors instead of failing the feed", async () => {
    const fetcher = async () => new Response(JSON.stringify({
      casts: [
        {
          hash: SAMPLE_HASH,
          text: "ok",
          timestamp: "2026-07-17T00:00:00.000Z",
          author: { username: "alice", fid: 1 },
        },
        {
          hash: OTHER_HASH,
          text: "bad",
          timestamp: "2026-07-17T00:00:00.000Z",
          author: { fid: 2 },
        },
      ],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
    const feed = await fetchNeynarFeed(fetcher, "key", "trending")
    expect(feed.casts).toHaveLength(1)
    expect(feed.casts[0]?.author).toBe("alice")
  })

  it("rejects oversized cast arrays", async () => {
    const casts = Array.from({ length: 101 }, (_, i) => ({
      hash: `0x${String(i).padStart(40, "0")}`,
      text: "x",
      timestamp: "2026-07-17T00:00:00.000Z",
      author: { username: "alice", fid: 1 },
    }))
    const fetcher = async () => new Response(JSON.stringify({ casts }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
    await expect(fetchNeynarFeed(fetcher, "key", "trending")).rejects.toThrow(/invalid casts/u)
  })
})

describe("fc write confinement", () => {
  it("forbids cast publish paths and allows like op", () => {
    expect(isForbiddenFcWritePath("/v2/farcaster/cast")).toBe(true)
    expect(isForbiddenFcWritePath("/v2/farcaster/reaction")).toBe(false)
    expect(isAllowedFcWriteOp("publish_reaction_like")).toBe(true)
    expect(isAllowedFcWriteOp("publish_cast")).toBe(false)
  })
})

describe("fc engagement policy", () => {
  it("accepts likes only for same-run FYP hashes and throttles", () => {
    const proposal = parseFcEngagementProposal({
      schema: 1,
      runId: "run-1",
      proposedAt: "2026-07-17T00:00:00.000Z",
      items: [
        {
          action: "like",
          castHash: SAMPLE_HASH,
          authorHandle: "alice",
          reasonCode: "narrative_signal",
          topics: [],
          rationale: "useful",
        },
        {
          action: "like",
          castHash: OTHER_HASH,
          authorHandle: "bob",
          reasonCode: "narrative_signal",
          topics: [],
          rationale: "outside",
        },
        {
          action: "like",
          castHash: "0x3333333333333333333333333333333333333333",
          authorHandle: "carol",
          reasonCode: "narrative_signal",
          topics: [],
          rationale: "third",
        },
      ],
    })
    const applied = applyFcEngagementChoices({
      proposal,
      state: emptyFcState(),
      caps,
      nowIso: "2026-07-17T00:05:00.000Z",
      fypCastHashes: [SAMPLE_HASH, "0x3333333333333333333333333333333333333333"],
    })
    expect(applied.accepted).toHaveLength(2)
    expect(applied.rejected.some((d) => d.rejectReason === "cast_hash_not_in_fyp")).toBe(true)
  })

  it("rejects when like window is exhausted", () => {
    const state = emptyFcState()
    state.receipts.push({
      schema: 1,
      receiptId: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      actionId: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      action: "like",
      target: SAMPLE_HASH,
      attemptedAt: "2026-07-17T00:01:00.000Z",
      verified: true,
      ambiguous: false,
    })
    state.receipts.push({
      schema: 1,
      receiptId: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      actionId: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      action: "like",
      target: OTHER_HASH,
      attemptedAt: "2026-07-17T00:02:00.000Z",
      verified: true,
      ambiguous: false,
    })
    expect(fcLikesInWindow(state, "2026-07-17T00:05:00.000Z", 10)).toBe(2)
    const proposal = parseFcEngagementProposal({
      schema: 1,
      runId: "run-2",
      proposedAt: "2026-07-17T00:05:00.000Z",
      items: [{
        action: "like",
        castHash: "0x3333333333333333333333333333333333333333",
        authorHandle: "alice",
        reasonCode: "narrative_signal",
        topics: [],
        rationale: "too many",
      }],
    })
    const applied = applyFcEngagementChoices({
      proposal,
      state,
      caps,
      nowIso: "2026-07-17T00:05:00.000Z",
      fypCastHashes: ["0x3333333333333333333333333333333333333333"],
    })
    expect(applied.accepted).toHaveLength(0)
    expect(applied.rejected[0]?.rejectReason).toBe("like_rate_limit")
  })
})

describe("fc engagement executor", () => {
  it("likes via driver and records verified receipts", async () => {
    const liked: string[] = []
    const result = await executeFcEngagementActions({
      accepted: [{
        schema: 1,
        actionId: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        action: "like",
        target: SAMPLE_HASH,
        reasonCode: "narrative_signal",
        topics: [],
        accepted: true,
        runId: "run-1",
        decidedAt: "2026-07-17T00:00:00.000Z",
      }],
      nowIso: "2026-07-17T00:00:00.000Z",
      apiKey: "test",
      signerUuid: "11111111-1111-4111-8111-111111111111",
      driver: {
        like: async (hash) => { liked.push(hash) },
      },
    })
    expect(liked).toEqual([SAMPLE_HASH])
    expect(result.verifiedActionIds).toHaveLength(1)
  })
})

describe("fc lifecycle", () => {
  it("registers discovery and computes follow diffs with confinement", () => {
    const file = registerFcDiscoveryCandidates(
      { schema: 1, candidates: [], transitions: [], pendingTransitionIds: [] },
      [
        { handle: "alice", fid: 10, origin: "fc-fyp" },
        { handle: "bob", fid: 11, origin: "fc-channel-1" },
      ],
      "2026-07-17T00:00:00.000Z",
    )
    expect(file.candidates).toHaveLength(2)
    expect(file.candidates[0]?.sourceId).toBe("fc_alice")
    const diff = computeFollowDiff({ desired: [10, 12], currentlyFollowing: [10, 11] })
    expect(diff.follow).toEqual([12])
    expect(diff.unfollow).toEqual([11])
    expect(confineFollowTargets([10, 99], new Set([10, 11]))).toEqual([10])
  })

  it("promotes when performance gates pass", () => {
    const file = registerFcDiscoveryCandidates(
      { schema: 1, candidates: [], transitions: [], pendingTransitionIds: [] },
      [{ handle: "alice", fid: 10, origin: "fc-fyp" }],
      "2026-07-01T00:00:00.000Z",
    )
    const perf: SourcePerformance = {
      eligibleCalls: 20,
      distinctTokens: 8,
      settledCalls: 15,
      hits: 12,
      coverage: 0.9,
      hitMean: 0.8,
      hitLb95: 0.6,
      medianExcess72h: 0.2,
      rugExposure: 0.01,
      lastEligibleCallAt: "2026-07-16T00:00:00.000Z",
      score: 0.8,
      scoreCutoff: "2026-07-17T00:00:00.000Z",
    }
    const reviewed = reviewFcSourceLifecycle({
      file,
      performances: new Map([["fc_alice", perf]]),
      epochId: "epoch-1",
      nowIso: "2026-07-17T00:00:00.000Z",
      thresholds: {
        max_transitions_per_review: 10,
        promotion: {
          min_eligible_calls: 10,
          min_distinct_tokens: 5,
          min_coverage: 0.8,
          min_hit_mean: 0.6,
          min_hit_lb95: 0.45,
          min_median_excess: 0.05,
          max_rug_exposure: 0.1,
          max_idle_days: 14,
        },
        demotion: {
          idle_days: 30,
          rug_exposure: 0.25,
          min_resolved_for_rug_drop: 4,
          coverage_floor: 0.5,
          score_floor: 0.4,
          consecutive_epochs: 2,
          readd_cooldown_days: 30,
          readd_min_new_calls: 5,
        },
      },
      capacity: 250,
    })
    expect(reviewed.applied).toHaveLength(1)
    expect(reviewed.applied[0]?.action).toBe("promoted")
    expect(reviewed.file.candidates[0]?.status).toBe("managed")
  })
})
