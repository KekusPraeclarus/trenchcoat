import { describe, expect, it, vi } from "vitest"
import { fetchFollowingFids, syncFollowGraph } from "../../src/collectors/farcaster/follow-sync.js"

describe("fetchFollowingFids pagination", () => {
  it("walks next cursors until exhausted", async () => {
    let calls = 0
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      calls += 1
      const url = String(input)
      if (!url.includes("cursor=page2")) {
        return new Response(JSON.stringify({
          users: [{ fid: 10 }, { fid: 11 }],
          next: { cursor: "page2" },
        }), { status: 200, headers: { "content-type": "application/json" } })
      }
      return new Response(JSON.stringify({ users: [{ fid: 12 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })
    const fids = await fetchFollowingFids(fetcher, "key", 1, { all: true })
    expect(fids).toEqual([10, 11, 12])
    expect(calls).toBe(2)
  })
})

describe("fc follow sync hardening", () => {
  it("paginates following fetches and verifies desired vs actual", async () => {
    let followingCalls = 0
    let following = [10, 11, 12]
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes("/following")) {
        followingCalls += 1
        if (followingCalls === 1) {
          return new Response(JSON.stringify({
            users: [{ fid: 10 }, { fid: 11 }],
            next: { cursor: "page2" },
          }), { status: 200, headers: { "content-type": "application/json" } })
        }
        if (followingCalls === 2) {
          return new Response(JSON.stringify({ users: [{ fid: 12 }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        return new Response(JSON.stringify({
          users: following.map((fid) => ({ fid })),
        }), { status: 200, headers: { "content-type": "application/json" } })
      }
      if (url.includes("/user/follow")) {
        if (init?.method === "DELETE") {
          following = following.filter((fid) => fid !== 11)
          return new Response(null, { status: 204 })
        }
        following = [...following, 13].sort((a, b) => a - b)
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
      }
      return new Response("{}", { status: 204 })
    })

    const receipt = await syncFollowGraph({
      apiKey: "key",
      signerUuid: "11111111-1111-4111-8111-111111111111",
      botFid: 1,
      desiredFids: [10, 12, 13],
      allowedFids: new Set([10, 11, 12, 13]),
      nowIso: "2026-07-18T00:00:00.000Z",
      fetcher,
    })

    expect(followingCalls).toBeGreaterThanOrEqual(3)
    expect(receipt.followed).toContain(13)
    expect(receipt.unfollowed).toContain(11)
    expect(receipt.verified).toBe(true)
    expect(receipt.actualFids).toEqual([10, 12, 13])
  })

  it("treats already-following and not-following as idempotent success", async () => {
    let followCalls = 0
    let following = [10]
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes("/following")) {
        return new Response(JSON.stringify({ users: following.map((fid) => ({ fid })) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.includes("/user/follow")) {
        followCalls += 1
        if (init?.method === "DELETE") {
          return new Response("not following", { status: 400 })
        }
        following = [...following, 11].sort((a, b) => a - b)
        return new Response("already following", { status: 400 })
      }
      return new Response("{}", { status: 200 })
    })

    const receipt = await syncFollowGraph({
      apiKey: "key",
      signerUuid: "11111111-1111-4111-8111-111111111111",
      botFid: 1,
      desiredFids: [10, 11],
      allowedFids: new Set([10, 11]),
      nowIso: "2026-07-18T00:00:00.000Z",
      fetcher,
    })

    expect(followCalls).toBe(1)
    expect(receipt.idempotentFollows).toEqual([11])
    expect(receipt.verified).toBe(true)
  })

  it("dry-run reports planned diff without mutation", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      users: [{ fid: 10 }],
    }), { status: 200, headers: { "content-type": "application/json" } }))
    const receipt = await syncFollowGraph({
      apiKey: "key",
      signerUuid: "11111111-1111-4111-8111-111111111111",
      botFid: 1,
      desiredFids: [12],
      allowedFids: new Set([10, 12]),
      nowIso: "2026-07-18T00:00:00.000Z",
      fetcher,
      dryRun: true,
    })
    expect(receipt.dryRun).toBe(true)
    expect(receipt.followed).toEqual([12])
    expect(receipt.unfollowed).toEqual([10])
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
