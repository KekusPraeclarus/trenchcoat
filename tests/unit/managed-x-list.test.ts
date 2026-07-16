import { describe, expect, it } from "vitest"
import {
  computeMembershipDiff,
  confineListId,
  graphqlOperationName,
  isAllowedListMutation,
  planSyncBatch,
  buildSyncReceipt,
  syncManagedListMembership,
  membershipIdempotencyKey,
  ALLOWED_LIST_MUTATIONS,
} from "../../src/collectors/twitter/managed-list.js"

describe("membership diff", () => {
  it("computes deterministic add/remove", () => {
    const diff = computeMembershipDiff(["Alice", "bob"], ["bob", "carol"])
    expect(diff.toAdd).toEqual(["carol"])
    expect(diff.toRemove).toEqual(["alice"])
  })
})

describe("list ID confinement", () => {
  it("refuses wrong list id", () => {
    expect(() => confineListId("111", "222")).toThrow(/confinement/i)
  })

  it("accepts matching ids", () => {
    expect(() => confineListId("111", "111")).not.toThrow()
  })
})

describe("mutation allowlist", () => {
  it("allows only CreateList/ListAddMember/ListRemoveMember", () => {
    for (const op of ALLOWED_LIST_MUTATIONS) {
      expect(isAllowedListMutation(op)).toBe(true)
    }
    expect(isAllowedListMutation("CreateTweet")).toBe(false)
    expect(isAllowedListMutation("FavoriteTweet")).toBe(false)
    expect(isAllowedListMutation("CreateFriendships")).toBe(false)
    expect(isAllowedListMutation(undefined)).toBe(false)
  })

  it("extracts operationName from GraphQL URL and body", () => {
    expect(graphqlOperationName(
      "https://x.com/i/api/graphql/abc/ListAddMember",
      null,
    )).toBe("ListAddMember")
    expect(graphqlOperationName(
      "https://x.com/i/api/graphql/abc/query",
      JSON.stringify({ operationName: "CreateTweet" }),
    )).toBe("CreateTweet")
  })
})

describe("sync planning", () => {
  it("caps transitions preferring removals", () => {
    const batch = planSyncBatch({
      managedListId: "99",
      desiredHandles: ["a", "b", "c"],
      currentHandles: ["x", "y", "z", "a"],
      maxTransitions: 2,
      nowIso: "2026-07-10T00:00:00.000Z",
    })
    expect(batch.toRemove.length + batch.toAdd.length).toBeLessThanOrEqual(2)
    expect(batch.toRemove.length).toBe(2)
    expect(batch.toAdd).toEqual([])
  })

  it("stable idempotency keys", () => {
    expect(membershipIdempotencyKey("1", "add", "Alice"))
      .toBe(membershipIdempotencyKey("1", "add", "alice"))
  })
})

describe("sync with injectable driver", () => {
  it("verifies membership and records receipt", async () => {
    const members = new Set(["alice"])
    const result = await syncManagedListMembership({
      managedListId: "12345",
      desiredHandles: ["alice", "bob"],
      maxTransitions: 10,
      nowIso: "2026-07-10T00:00:00.000Z",
      driver: {
        scrapeMembers: async () => [...members],
        addMember: async (_id, handle) => { members.add(handle) },
        removeMember: async (_id, handle) => { members.delete(handle) },
      },
    })
    expect(result.receipt.added).toEqual(["bob"])
    expect(result.receipt.verified).toBe(true)
    expect(result.receipt.ambiguous).toBe(false)
  })

  it("marks ambiguous on verification failure", async () => {
    const result = await syncManagedListMembership({
      managedListId: "12345",
      desiredHandles: ["bob"],
      maxTransitions: 10,
      nowIso: "2026-07-10T00:00:00.000Z",
      driver: {
        scrapeMembers: async () => [],
        addMember: async () => undefined,
        removeMember: async () => undefined,
      },
    })
    expect(result.receipt.ambiguous).toBe(true)
    expect(result.receipt.verified).toBe(false)
  })

  it("builds durable receipts", () => {
    const receipt = buildSyncReceipt({
      managedListId: "1",
      desiredHandles: ["a"],
      added: ["a"],
      removed: [],
      verified: true,
      ambiguous: false,
      nowIso: "2026-07-10T00:00:00.000Z",
    })
    expect(receipt.syncId.startsWith("sha256:")).toBe(true)
    expect(receipt.schema).toBe(1)
  })
})
