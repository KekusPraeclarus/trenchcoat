import { describe, expect, it } from "vitest"
import {
  applyPumpEngagementChoices,
  currentFollowCount,
  parsePumpEngagementProposal,
} from "../../src/social/pump-engagement.js"
import type { PumpEngagementFile } from "../../src/contracts/schemas.js"

const NOW = "2026-08-13T12:00:00.000Z"
const RUN = "pump-scan-1"

function emptyState(): PumpEngagementFile {
  return {
    schema: 1,
    followedHandles: [],
    likedItemIds: [],
    lastLikedAt: {},
    lastFollowedAt: {},
    pendingActionIds: [],
    decisions: [],
    receipts: [],
    daily: { day: "2026-08-13", likes: 0, follows: 0, unfollows: 0 },
  }
}

const caps = {
  enabled: true,
  likes_per_window: 2,
  like_window_minutes: 10,
  max_follows_per_run: 3,
}

describe("applyPumpEngagementChoices", () => {
  it("binds likes and follows to same-run eligible snapshot", () => {
    const proposal = parsePumpEngagementProposal({
      schema: 1,
      runId: RUN,
      proposedAt: NOW,
      items: [
        {
          action: "like",
          itemId: "coin-1",
          authorHandle: "alice.calls",
          reasonCode: "chart-quality",
          rationale: "clean chart",
        },
        {
          action: "follow",
          handle: "alice.calls",
          reasonCode: "hit-rate",
          rationale: "hits",
        },
      ],
    })
    const applied = applyPumpEngagementChoices({
      proposal,
      state: emptyState(),
      caps,
      nowIso: NOW,
      eligibleItemIds: ["coin-1"],
      eligibleAuthors: ["alice.calls"],
    })
    expect(applied.accepted).toHaveLength(2)
    expect(applied.rejected).toHaveLength(0)
  })

  it("rejects likes not in eligible and follows over the per-run cap", () => {
    const proposal = parsePumpEngagementProposal({
      schema: 1,
      runId: RUN,
      proposedAt: NOW,
      items: [
        {
          action: "like",
          itemId: "outside",
          authorHandle: "alice.calls",
          reasonCode: "chart-quality",
          rationale: "no",
        },
        {
          action: "follow",
          handle: "a1",
          reasonCode: "hit-rate",
          rationale: "a",
        },
        {
          action: "follow",
          handle: "a2",
          reasonCode: "hit-rate",
          rationale: "b",
        },
        {
          action: "follow",
          handle: "a3",
          reasonCode: "hit-rate",
          rationale: "c",
        },
        {
          action: "follow",
          handle: "a4",
          reasonCode: "hit-rate",
          rationale: "d",
        },
      ],
    })
    const applied = applyPumpEngagementChoices({
      proposal,
      state: emptyState(),
      caps,
      nowIso: NOW,
      eligibleItemIds: ["coin-1"],
      eligibleAuthors: ["a1", "a2", "a3", "a4"],
    })
    expect(applied.rejected.some((d) => d.rejectReason === "item_id_not_in_eligible")).toBe(true)
    expect(applied.accepted.filter((d) => d.action === "follow")).toHaveLength(3)
    expect(applied.rejected.some((d) => d.rejectReason === "follow_rate_limit")).toBe(true)
  })

  it("counts current follows for the Following tab gate", () => {
    const state = emptyState()
    expect(currentFollowCount(state)).toBe(0)
    expect(currentFollowCount({
      ...state,
      followedHandles: Array.from({ length: 10 }, (_, i) => `user${i}`),
    })).toBe(10)
  })
})
