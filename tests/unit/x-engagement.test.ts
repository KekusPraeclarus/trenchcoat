import { describe, expect, it } from "vitest"
import {
  applyEngagementChoices,
  parseEngagementProposal,
  engagementActionId,
  likesInWindow,
  type EngagementCaps,
} from "../../src/social/x-engagement.js"
import type { XEngagementFile } from "../../src/contracts/schemas.js"
import {
  executeEngagementActions,
  isAllowedEngagementMutation,
  isForbiddenEngagementMutation,
} from "../../src/collectors/twitter/engagement.js"
import { registerDiscoveryCandidates } from "../../src/sources/lifecycle.js"

const caps: EngagementCaps = {
  enabled: true,
  likes_per_window: 2,
  like_window_minutes: 10,
}

function emptyState(): XEngagementFile {
  return {
    schema: 1,
    followedHandles: [],
    likedPostIds: [],
    lastLikedAt: {},
    lastFollowedAt: {},
    pendingActionIds: [],
    decisions: [],
    receipts: [],
    daily: { day: "2026-07-16", likes: 0, follows: 0, unfollows: 0 },
  }
}

describe("discovery from all feeds", () => {
  it("registers FYP and both operator lists", () => {
    const file = registerDiscoveryCandidates(
      { schema: 1, candidates: [], transitions: [], pendingTransitionIds: [] },
      [
        { handle: "a", origin: "fyp" },
        { handle: "b", origin: "operator-list-1" },
        { handle: "c", origin: "operator-list-2" },
      ],
      "2026-07-16T00:00:00.000Z",
    )
    expect(file.candidates).toHaveLength(3)
  })
})

describe("bot-controlled engagement", () => {
  it("accepts likes and follows without FYP provenance checks", () => {
    const proposal = parseEngagementProposal({
      schema: 1,
      runId: "list-scan-1",
      proposedAt: "2026-07-16T00:00:00.000Z",
      items: [
        {
          action: "like",
          postId: "1234567890",
          authorHandle: "alpha",
          reasonCode: "narrative_signal",
          topics: ["base-ai"],
          rationale: "useful framing",
        },
        {
          action: "follow",
          handle: "beta",
          reasonCode: "sentiment_coverage",
          topics: ["base-ai"],
          rationale: "consistent sentiment",
        },
      ],
    })
    const result = applyEngagementChoices({
      proposal,
      state: emptyState(),
      caps,
      nowIso: "2026-07-16T00:00:00.000Z",
    })
    expect(result.accepted).toHaveLength(2)
    expect(result.rejected).toHaveLength(0)
  })

  it("enforces 2 likes per 10 minute window", () => {
    const mkLike = (postId: string) => ({
      action: "like" as const,
      postId,
      authorHandle: "alpha",
      reasonCode: "narrative_signal",
      topics: [],
      rationale: "ok",
    })
    const proposal = parseEngagementProposal({
      schema: 1,
      runId: "list-scan-1",
      proposedAt: "2026-07-16T00:00:00.000Z",
      items: [mkLike("1111111111"), mkLike("2222222222"), mkLike("3333333333")],
    })
    const result = applyEngagementChoices({
      proposal,
      state: emptyState(),
      caps,
      nowIso: "2026-07-16T00:00:00.000Z",
    })
    expect(result.accepted).toHaveLength(2)
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0]?.rejectReason).toBe("like_rate_limit")
  })

  it("counts prior likes in the sliding window", () => {
    const state = emptyState()
    state.lastLikedAt["1111111111"] = "2026-07-16T00:05:00.000Z"
    state.receipts.push({
      schema: 1,
      receiptId: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      actionId: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      action: "like",
      target: "1111111111",
      attemptedAt: "2026-07-16T00:05:00.000Z",
      verified: true,
      ambiguous: false,
    })
    expect(likesInWindow(state, "2026-07-16T00:10:00.000Z", 10)).toBe(1)

    const proposal = parseEngagementProposal({
      schema: 1,
      runId: "list-scan-2",
      proposedAt: "2026-07-16T00:10:00.000Z",
      items: [
        {
          action: "like",
          postId: "2222222222",
          authorHandle: "alpha",
          reasonCode: "narrative_signal",
          topics: [],
          rationale: "ok",
        },
        {
          action: "like",
          postId: "3333333333",
          authorHandle: "alpha",
          reasonCode: "narrative_signal",
          topics: [],
          rationale: "ok",
        },
      ],
    })
    const result = applyEngagementChoices({
      proposal,
      state,
      caps,
      nowIso: "2026-07-16T00:10:00.000Z",
    })
    expect(result.accepted).toHaveLength(1)
    expect(result.rejected[0]?.rejectReason).toBe("like_rate_limit")
  })

  it("is idempotent on duplicate action ids", () => {
    const item = {
      action: "like" as const,
      postId: "1234567890",
      authorHandle: "alpha",
      reasonCode: "narrative_signal",
      topics: [],
      rationale: "ok",
    }
    const proposal = parseEngagementProposal({
      schema: 1,
      runId: "list-scan-1",
      proposedAt: "2026-07-16T00:00:00.000Z",
      items: [item, item],
    })
    const first = applyEngagementChoices({
      proposal,
      state: emptyState(),
      caps,
      nowIso: "2026-07-16T00:00:00.000Z",
    })
    expect(first.accepted).toHaveLength(1)
    expect(first.rejected[0]?.rejectReason).toBe("duplicate_action_id")
    expect(engagementActionId(item, "list-scan-1").startsWith("sha256:")).toBe(true)
  })
})

describe("engagement executor allowlist", () => {
  it("allows only favorite/friendship ops and blocks posts/dms/retweets", () => {
    expect(isAllowedEngagementMutation("FavoriteTweet")).toBe(true)
    expect(isAllowedEngagementMutation("CreateFriendships")).toBe(true)
    expect(isForbiddenEngagementMutation("CreateTweet")).toBe(true)
    expect(isForbiddenEngagementMutation("CreateRetweet")).toBe(true)
    expect(isForbiddenEngagementMutation("dmSendMessage")).toBe(true)
    expect(isForbiddenEngagementMutation("ListAddMember")).toBe(true)
  })

  it("records verified and ambiguous receipts via driver", async () => {
    const accepted = [{
      schema: 1 as const,
      actionId: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const,
      action: "like" as const,
      target: "123",
      reasonCode: "narrative_signal",
      topics: [],
      accepted: true,
      runId: "r1",
      decidedAt: "2026-07-16T00:00:00.000Z",
    }]
    const ok = await executeEngagementActions({
      accepted,
      nowIso: "2026-07-16T00:00:00.000Z",
      driver: {
        like: async () => undefined,
        follow: async () => undefined,
        unfollow: async () => undefined,
        verifyLiked: async () => true,
      },
    })
    expect(ok.verifiedActionIds).toHaveLength(1)
  })
})
