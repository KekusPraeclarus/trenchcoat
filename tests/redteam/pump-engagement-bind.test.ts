import { describe, expect, it } from "vitest"
import {
  applyPumpEngagementChoices,
  parsePumpEngagementProposal,
} from "../../src/social/pump-engagement.js"
import type { PumpEngagementFile } from "../../src/contracts/schemas.js"

const NOW = "2026-08-13T12:00:00.000Z"

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

describe("pump engagement bind redteam", () => {
  it("rejects like and follow targets absent from the eligible snapshot", () => {
    const proposal = parsePumpEngagementProposal({
      schema: 1,
      runId: "pump-scan-1",
      proposedAt: NOW,
      items: [
        {
          action: "like",
          itemId: "outside-item",
          authorHandle: "alice.calls",
          reasonCode: "chart-quality",
          rationale: "no",
        },
        {
          action: "follow",
          handle: "outside-author",
          reasonCode: "hit-rate",
          rationale: "no",
        },
      ],
    })
    const applied = applyPumpEngagementChoices({
      proposal,
      state: emptyState(),
      caps: {
        enabled: true,
        likes_per_window: 2,
        like_window_minutes: 10,
        max_follows_per_run: 3,
      },
      nowIso: NOW,
      eligibleItemIds: ["coin-1"],
      eligibleAuthors: ["alice.calls"],
    })
    expect(applied.accepted).toHaveLength(0)
    expect(applied.rejected.some((d) => d.rejectReason === "item_id_not_in_eligible")).toBe(true)
    expect(applied.rejected.some((d) => d.rejectReason === "handle_not_in_eligible")).toBe(true)
  })
})
