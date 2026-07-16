import { describe, expect, it } from "vitest"
import {
  isAllowedEngagementMutation,
  isForbiddenEngagementMutation,
  executeEngagementActions,
} from "../../src/collectors/twitter/engagement.js"
import { graphqlOperationName } from "../../src/collectors/twitter/managed-list.js"

describe("contract x-engagement mutations", () => {
  it("blocks CreateTweet/CreateRetweet/DM even when body names them", () => {
    for (const op of ["CreateTweet", "CreateRetweet", "dmSendMessage", "CreateReply"]) {
      expect(isForbiddenEngagementMutation(op)).toBe(true)
      expect(isAllowedEngagementMutation(op)).toBe(false)
    }
  })

  it("parses favorite operation from body when path is query", () => {
    expect(graphqlOperationName(
      "https://x.com/i/api/graphql/abc/query",
      JSON.stringify({ operationName: "FavoriteTweet" }),
    )).toBe("FavoriteTweet")
    expect(isAllowedEngagementMutation("FavoriteTweet")).toBe(true)
  })

  it("does not invent success on driver failure", async () => {
    const result = await executeEngagementActions({
      accepted: [{
        schema: 1,
        actionId: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        action: "follow",
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
        follow: async () => { throw new Error("timeout") },
        unfollow: async () => undefined,
      },
    })
    expect(result.receipts[0]?.ambiguous).toBe(true)
    expect(result.verifiedActionIds).toHaveLength(0)
  })
})
