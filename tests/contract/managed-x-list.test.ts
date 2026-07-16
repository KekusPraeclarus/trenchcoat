import { describe, expect, it } from "vitest"
import {
  graphqlOperationName,
  isAllowedListMutation,
  confineListId,
  computeMembershipDiff,
  planSyncBatch,
  syncManagedListMembership,
} from "../../src/collectors/twitter/managed-list.js"

describe("contract managed-x-list", () => {
  it("blocks non-list GraphQL mutations by name", () => {
    const blocked = [
      "CreateTweet",
      "FavoriteTweet",
      "CreateRetweet",
      "CreateFriendships",
      "dmSendMessage",
      "DeleteTweet",
    ]
    for (const op of blocked) {
      expect(isAllowedListMutation(op)).toBe(false)
    }
    expect(isAllowedListMutation("ListAddMember")).toBe(true)
    expect(isAllowedListMutation("ListRemoveMember")).toBe(true)
    expect(isAllowedListMutation("CreateList")).toBe(true)
  })

  it("parses operation names from X graphql URLs", () => {
    expect(graphqlOperationName(
      "https://x.com/i/api/graphql/AbCdEf/FavoriteTweet?variables={}",
      null,
    )).toBe("FavoriteTweet")
  })

  it("refuses sync planning when list ids diverge at confine boundary", () => {
    expect(() => confineListId("100", "999")).toThrow()
  })

  it("plans bounded batches from membership drift", () => {
    const diff = computeMembershipDiff(["a", "b"], ["b", "c", "d"])
    expect(diff.toRemove).toEqual(["a"])
    expect(diff.toAdd).toEqual(["c", "d"])
    const batch = planSyncBatch({
      managedListId: "42",
      currentHandles: ["a", "b"],
      desiredHandles: ["b", "c", "d"],
      maxTransitions: 1,
      nowIso: "2026-07-10T00:00:00.000Z",
    })
    expect(batch.toRemove).toEqual(["a"])
    expect(batch.toAdd).toEqual([])
  })

  it("retries ambiguous scrape failures without mutating", async () => {
    let scrapes = 0
    const result = await syncManagedListMembership({
      managedListId: "42",
      desiredHandles: ["alice"],
      maxTransitions: 5,
      nowIso: "2026-07-10T00:00:00.000Z",
      driver: {
        scrapeMembers: async () => {
          scrapes += 1
          throw new Error("timeout")
        },
        addMember: async () => {
          throw new Error("should not add")
        },
        removeMember: async () => {
          throw new Error("should not remove")
        },
      },
    })
    expect(scrapes).toBe(1)
    expect(result.receipt.ambiguous).toBe(true)
    expect(result.receipt.added).toEqual([])
    expect(result.receipt.removed).toEqual([])
  })
})
