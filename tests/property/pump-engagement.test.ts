import { describe, expect, it } from "vitest"
import * as fc from "fast-check"
import {
  applyPumpEngagementChoices,
  parsePumpEngagementProposal,
} from "../../src/social/pump-engagement.js"
import type { PumpEngagementFile } from "../../src/contracts/schemas.js"

const NOW = "2026-08-13T12:00:00.000Z"
const caps = {
  enabled: true,
  likes_per_window: 2,
  like_window_minutes: 10,
  max_follows_per_run: 3,
}

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

const handleArb = fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{2,11}$/u)
const itemIdArb = fc.stringMatching(/^coin-[A-Za-z0-9]{2,8}$/u)

describe("prop pump engagement bind and caps", () => {
  it("accepted likes and follows stay in the eligible set and respect caps", () => {
    fc.assert(fc.property(
      fc.uniqueArray(itemIdArb, { minLength: 1, maxLength: 8 }),
      fc.uniqueArray(handleArb, { minLength: 1, maxLength: 8 }),
      (itemIds, authors) => {
        const likeItems = itemIds.slice(0, 5).map((itemId) => ({
          action: "like" as const,
          itemId,
          authorHandle: authors[0]!,
          reasonCode: "chart-quality",
          rationale: "chart",
        }))
        const followItems = authors.slice(0, 5).map((handle) => ({
          action: "follow" as const,
          handle,
          reasonCode: "hit-rate",
          rationale: "hits",
        }))
        const proposal = parsePumpEngagementProposal({
          schema: 1,
          runId: "pump-scan-prop-1",
          proposedAt: NOW,
          items: [...likeItems, ...followItems],
        })
        const applied = applyPumpEngagementChoices({
          proposal,
          state: emptyState(),
          caps,
          nowIso: NOW,
          eligibleItemIds: itemIds,
          eligibleAuthors: authors,
        })
        const acceptedLikes = applied.accepted.filter((d) => d.action === "like")
        const acceptedFollows = applied.accepted.filter((d) => d.action === "follow")
        expect(acceptedLikes.every((d) => itemIds.includes(d.target))).toBe(true)
        expect(acceptedFollows.every((d) => authors.includes(d.target))).toBe(true)
        expect(acceptedLikes.length).toBeLessThanOrEqual(2)
        expect(acceptedFollows.length).toBeLessThanOrEqual(3)
      },
    ), { numRuns: 25 })
  })
})
