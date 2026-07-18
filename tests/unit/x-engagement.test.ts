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
  isAllowedEngagementRestUrl,
  isForbiddenEngagementMutation,
  isEngagementChallengeUrl,
  ENGAGEMENT_VERIFY_ATTEMPTS,
  retryEngagementVerify,
} from "../../src/collectors/twitter/engagement.js"
import { registerDiscoveryCandidates } from "../../src/sources/lifecycle.js"
import { processListScanEngagement } from "../../src/orchestrator/x-engagement.js"
import { writeXFypEligibleSnapshot } from "../../src/orchestrator/x-fyp-eligible.js"
import { SnapshotWriter } from "../../src/lib/snapshot.js"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

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
  const fypPostIds = ["1234567890", "1111111111", "2222222222", "3333333333"]
  const fypAuthors = ["alpha", "beta", "gamma"]

  it("prop_inv_s22_accepts likes only for same-run FYP post ids", () => {
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
      fypPostIds,
      fypAuthors,
    })
    expect(result.accepted).toHaveLength(2)
    expect(result.rejected).toHaveLength(0)
  })

  it("prop_inv_s22_accepts follow/unfollow only for same-run FYP authors", () => {
    // unfollow only applies to a currently-followed handle
    const state = emptyState()
    state.followedHandles = ["gamma"]
    const proposal = parseEngagementProposal({
      schema: 1,
      runId: "list-scan-1",
      proposedAt: "2026-07-16T00:00:00.000Z",
      items: [
        {
          action: "follow",
          handle: "beta",
          reasonCode: "sentiment_coverage",
          topics: [],
          rationale: "seen in feed",
        },
        {
          action: "unfollow",
          handle: "gamma",
          reasonCode: "sentiment_coverage",
          topics: [],
          rationale: "seen in feed",
        },
      ],
    })
    const result = applyEngagementChoices({
      proposal,
      state,
      caps,
      nowIso: "2026-07-16T00:00:00.000Z",
      fypPostIds,
      fypAuthors,
    })
    expect(result.accepted).toHaveLength(2)
    expect(result.rejected).toHaveLength(0)
  })

  it("rejects follow/unfollow for authors not in the collected FYP set", () => {
    const proposal = parseEngagementProposal({
      schema: 1,
      runId: "list-scan-1",
      proposedAt: "2026-07-16T00:00:00.000Z",
      items: [
        {
          action: "follow",
          handle: "spoof",
          reasonCode: "sentiment_coverage",
          topics: [],
          rationale: "never seen",
        },
        {
          action: "unfollow",
          handle: "phantom",
          reasonCode: "sentiment_coverage",
          topics: [],
          rationale: "never seen",
        },
      ],
    })
    const result = applyEngagementChoices({
      proposal,
      state: emptyState(),
      caps,
      nowIso: "2026-07-16T00:00:00.000Z",
      fypPostIds,
      fypAuthors,
    })
    expect(result.accepted).toHaveLength(0)
    expect(result.rejected.map((r) => r.rejectReason)).toEqual([
      "handle_not_in_fyp",
      "handle_not_in_fyp",
    ])
  })

  it("rejects follow when no FYP authors were collected", () => {
    const proposal = parseEngagementProposal({
      schema: 1,
      runId: "list-scan-1",
      proposedAt: "2026-07-16T00:00:00.000Z",
      items: [{
        action: "follow",
        handle: "beta",
        reasonCode: "sentiment_coverage",
        topics: [],
        rationale: "no snapshot",
      }],
    })
    const result = applyEngagementChoices({
      proposal,
      state: emptyState(),
      caps,
      nowIso: "2026-07-16T00:00:00.000Z",
      fypPostIds,
    })
    expect(result.rejected[0]?.rejectReason).toBe("handle_not_in_fyp")
  })

  it("prop_inv_s22_rejects likes not in the collected FYP set", () => {
    const proposal = parseEngagementProposal({
      schema: 1,
      runId: "list-scan-1",
      proposedAt: "2026-07-16T00:00:00.000Z",
      items: [{
        action: "like",
        postId: "9999999999",
        authorHandle: "spoof",
        reasonCode: "narrative_signal",
        topics: [],
        rationale: "spoofed",
      }],
    })
    const result = applyEngagementChoices({
      proposal,
      state: emptyState(),
      caps,
      nowIso: "2026-07-16T00:00:00.000Z",
      fypPostIds,
    })
    expect(result.accepted).toHaveLength(0)
    expect(result.rejected[0]?.rejectReason).toBe("post_id_not_in_fyp")
  })

  it("prop_inv_s22_rejects likes when no FYP snapshot was collected", () => {
    const proposal = parseEngagementProposal({
      schema: 1,
      runId: "list-scan-1",
      proposedAt: "2026-07-16T00:00:00.000Z",
      items: [{
        action: "like",
        postId: "1234567890",
        authorHandle: "alpha",
        reasonCode: "narrative_signal",
        topics: [],
        rationale: "ok",
      }],
    })
    const result = applyEngagementChoices({
      proposal,
      state: emptyState(),
      caps,
      nowIso: "2026-07-16T00:00:00.000Z",
    })
    expect(result.rejected[0]?.rejectReason).toBe("post_id_not_in_fyp")
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
      fypPostIds,
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
      fypPostIds,
    })
    expect(result.accepted).toHaveLength(1)
    expect(result.rejected[0]?.rejectReason).toBe("like_rate_limit")
  })

  it("rejects follow when handle already in followedHandles, leaving daily unchanged", () => {
    const state = emptyState()
    state.followedHandles = ["Beta"]
    const proposal = parseEngagementProposal({
      schema: 1,
      runId: "list-scan-1",
      proposedAt: "2026-07-16T00:00:00.000Z",
      items: [{
        action: "follow",
        handle: "beta",
        reasonCode: "sentiment_coverage",
        topics: [],
        rationale: "already followed",
      }],
    })
    const result = applyEngagementChoices({
      proposal,
      state,
      caps,
      nowIso: "2026-07-16T00:00:00.000Z",
      fypPostIds,
      fypAuthors,
    })
    expect(result.accepted).toHaveLength(0)
    expect(result.rejected[0]?.rejectReason).toBe("already_following")
    expect(result.nextState.daily.follows).toBe(0)
  })

  it("rejects unfollow when handle not in followedHandles", () => {
    const proposal = parseEngagementProposal({
      schema: 1,
      runId: "list-scan-1",
      proposedAt: "2026-07-16T00:00:00.000Z",
      items: [{
        action: "unfollow",
        handle: "beta",
        reasonCode: "sentiment_coverage",
        topics: [],
        rationale: "not followed",
      }],
    })
    const result = applyEngagementChoices({
      proposal,
      state: emptyState(),
      caps,
      nowIso: "2026-07-16T00:00:00.000Z",
      fypPostIds,
      fypAuthors,
    })
    expect(result.accepted).toHaveLength(0)
    expect(result.rejected[0]?.rejectReason).toBe("not_following")
    expect(result.nextState.daily.unfollows).toBe(0)
  })

  it("rejects like when post already in likedPostIds", () => {
    const state = emptyState()
    state.likedPostIds = ["1234567890"]
    const proposal = parseEngagementProposal({
      schema: 1,
      runId: "list-scan-1",
      proposedAt: "2026-07-16T00:00:00.000Z",
      items: [{
        action: "like",
        postId: "1234567890",
        authorHandle: "alpha",
        reasonCode: "narrative_signal",
        topics: [],
        rationale: "already liked",
      }],
    })
    const result = applyEngagementChoices({
      proposal,
      state,
      caps,
      nowIso: "2026-07-16T00:00:00.000Z",
      fypPostIds,
    })
    expect(result.accepted).toHaveLength(0)
    expect(result.rejected[0]?.rejectReason).toBe("already_liked")
    expect(result.nextState.daily.likes).toBe(0)
  })

  it("rejects a re-liked post across runs via a verified receipt", () => {
    const state = emptyState()
    state.receipts.push({
      schema: 1,
      receiptId: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      actionId: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      action: "like",
      target: "1234567890",
      attemptedAt: "2026-07-15T00:00:00.000Z",
      verified: true,
      ambiguous: false,
    })
    const proposal = parseEngagementProposal({
      schema: 1,
      runId: "list-scan-later",
      proposedAt: "2026-07-16T00:00:00.000Z",
      items: [{
        action: "like",
        postId: "1234567890",
        authorHandle: "alpha",
        reasonCode: "narrative_signal",
        topics: [],
        rationale: "seen again",
      }],
    })
    const result = applyEngagementChoices({
      proposal,
      state,
      caps,
      nowIso: "2026-07-16T00:00:00.000Z",
      fypPostIds,
    })
    expect(result.accepted).toHaveLength(0)
    expect(result.rejected[0]?.rejectReason).toBe("already_liked")
  })

  it("rejects a duplicate action still pending execution from another run", () => {
    const state = emptyState()
    const pendingId = "sha256:3333333333333333333333333333333333333333333333333333333333333333" as const
    state.pendingActionIds = [pendingId]
    state.decisions = [{
      schema: 1,
      actionId: pendingId,
      action: "follow",
      target: "beta",
      reasonCode: "sentiment_coverage",
      topics: [],
      accepted: true,
      runId: "list-scan-prior",
      decidedAt: "2026-07-15T00:00:00.000Z",
    }]
    const proposal = parseEngagementProposal({
      schema: 1,
      runId: "list-scan-later",
      proposedAt: "2026-07-16T00:00:00.000Z",
      items: [{
        action: "follow",
        handle: "beta",
        reasonCode: "sentiment_coverage",
        topics: [],
        rationale: "still pending",
      }],
    })
    const result = applyEngagementChoices({
      proposal,
      state,
      caps,
      nowIso: "2026-07-16T00:00:00.000Z",
      fypPostIds,
      fypAuthors,
    })
    expect(result.accepted).toHaveLength(0)
    expect(result.rejected[0]?.rejectReason).toBe("pending_duplicate")
    expect(result.nextState.daily.follows).toBe(0)
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
      fypPostIds,
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

  it("allows legacy REST friendship create/destroy URLs", () => {
    expect(isAllowedEngagementRestUrl("https://x.com/i/api/1.1/friendships/destroy.json")).toBe(true)
    expect(isAllowedEngagementRestUrl("https://x.com/i/api/1.1/friendships/create.json?user_id=1")).toBe(true)
    expect(isAllowedEngagementRestUrl("https://x.com/i/api/1.1/friendships/lookup.json")).toBe(false)
  })

  it("detects login/challenge URLs", () => {
    expect(isEngagementChallengeUrl("https://x.com/i/flow/login")).toBe(true)
    expect(isEngagementChallengeUrl("https://x.com/account/access")).toBe(true)
    expect(isEngagementChallengeUrl("https://x.com/home")).toBe(false)
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

  it("treats already-liked as verified idempotent success", async () => {
    const accepted = [{
      schema: 1 as const,
      actionId: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as const,
      action: "like" as const,
      target: "123",
      reasonCode: "narrative_signal",
      topics: [],
      accepted: true,
      runId: "r1",
      decidedAt: "2026-07-16T00:00:00.000Z",
    }]
    const result = await executeEngagementActions({
      accepted,
      nowIso: "2026-07-16T00:00:00.000Z",
      driver: {
        like: async () => undefined,
        follow: async () => undefined,
        unfollow: async () => undefined,
        verifyLiked: async () => true,
      },
    })
    expect(result.receipts[0]?.verified).toBe(true)
    expect(result.receipts[0]?.ambiguous).toBe(false)
  })

  it("treats already-following and already-not-following as verified idempotent success", async () => {
    const follow = await executeEngagementActions({
      accepted: [{
        schema: 1 as const,
        actionId: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" as const,
        action: "follow" as const,
        target: "alpha",
        reasonCode: "sentiment_coverage",
        topics: [],
        accepted: true,
        runId: "r1",
        decidedAt: "2026-07-16T00:00:00.000Z",
      }],
      nowIso: "2026-07-16T00:00:00.000Z",
      driver: {
        like: async () => undefined,
        follow: async () => undefined,
        unfollow: async () => undefined,
        verifyFollowing: async () => true,
      },
    })
    expect(follow.receipts[0]?.verified).toBe(true)

    const unfollow = await executeEngagementActions({
      accepted: [{
        schema: 1 as const,
        actionId: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as const,
        action: "unfollow" as const,
        target: "beta",
        reasonCode: "sentiment_coverage",
        topics: [],
        accepted: true,
        runId: "r1",
        decidedAt: "2026-07-16T00:00:00.000Z",
      }],
      nowIso: "2026-07-16T00:00:00.000Z",
      driver: {
        like: async () => undefined,
        follow: async () => undefined,
        unfollow: async () => undefined,
        verifyFollowing: async () => false,
      },
    })
    expect(unfollow.receipts[0]?.verified).toBe(true)
  })

  it("retries bounded verification before failing", async () => {
    let attempts = 0
    const verified = await retryEngagementVerify(async () => {
      attempts += 1
      return attempts >= ENGAGEMENT_VERIFY_ATTEMPTS
    })
    expect(verified).toBe(true)
    expect(attempts).toBe(ENGAGEMENT_VERIFY_ATTEMPTS)
  })

  it("marks ambiguous when verification never succeeds", async () => {
    const accepted = [{
      schema: 1 as const,
      actionId: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" as const,
      action: "like" as const,
      target: "123",
      reasonCode: "narrative_signal",
      topics: [],
      accepted: true,
      runId: "r1",
      decidedAt: "2026-07-16T00:00:00.000Z",
    }]
    const result = await executeEngagementActions({
      accepted,
      nowIso: "2026-07-16T00:00:00.000Z",
      driver: {
        like: async () => undefined,
        follow: async () => undefined,
        unfollow: async () => undefined,
        verifyLiked: async () => false,
      },
    })
    expect(result.ambiguousActionIds).toHaveLength(1)
  })
})

describe("x-engagement dry-run manifest binding", () => {
  it("loads FYP manifest from live inbox for dry-run parity", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-dry-run-"))
    const archiveRoot = join(root, "archive")
    const runId = "list-scan-dry"
    mkdirSync(join(root, "state"), { recursive: true })
    mkdirSync(join(root, "reports", runId), { recursive: true })
    writeFileSync(join(root, "state", "x-engagement.json"), `${JSON.stringify({
      schema: 1,
      followedHandles: [],
      likedPostIds: [],
      lastLikedAt: {},
      lastFollowedAt: {},
      pendingActionIds: [],
      decisions: [],
      receipts: [],
      daily: { day: "2026-07-18", likes: 0, follows: 0, unfollows: 0 },
    }, null, 2)}\n`)
    writeFileSync(join(root, "reports", runId, "x-engagement.json"), `${JSON.stringify({
      schema: 1,
      runId,
      proposedAt: "2026-07-18T12:00:00.000Z",
      items: [{
        action: "like",
        postId: "1234567890",
        authorHandle: "alpha",
        reasonCode: "narrative_signal",
        topics: [],
        rationale: "useful",
      }, {
        action: "like",
        postId: "9999999999",
        authorHandle: "spoof",
        reasonCode: "narrative_signal",
        topics: [],
        rationale: "off fyp",
      }],
    }, null, 2)}\n`)

    const writer = new SnapshotWriter(root)
    await writeXFypEligibleSnapshot({
      writer,
      runId,
      fetchedAt: "2026-07-18T12:00:00.000Z",
      posts: [{ id: "1234567890", author: "alpha" }],
    })

    const report = await processListScanEngagement({
      agentRoot: root,
      archiveRoot,
      runId,
      dryRun: true,
      execute: false,
    })
    expect(report.fypEligiblePosts).toBe(1)
    expect(report.accepted).toBe(1)
    expect(report.rejected).toBe(1)
    expect(report.decisions.find((d) => d.rejectReason === "post_id_not_in_fyp")).toBeTruthy()
  })
})
