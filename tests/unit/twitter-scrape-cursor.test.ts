import { describe, expect, it } from "vitest"
import {
  accumulatePostsUntilCursor,
} from "../../src/collectors/twitter/scrape-cursor.js"
import { shouldRetryEmptyTimeline } from "../../src/collectors/twitter/scrape.js"

describe("accumulatePostsUntilCursor", () => {
  const post = (id: string) => ({
    id,
    author: "a",
    text: "t",
    url: `https://x.com/a/status/${id}`,
    timestamp: "2026-07-20T00:00:00.000Z",
    provenance: `twitter:${id}`,
    engagement: {},
  })

  it("stops when the prior cursor post reappears and excludes it", () => {
    const result = accumulatePostsUntilCursor({
      batches: [
        [post("30"), post("29"), post("28")],
        [post("28"), post("27"), post("20")],
      ],
      stopAtPostId: "20",
    })
    expect(result.hitCursor).toBe(true)
    expect(result.newestPostId).toBe("30")
    expect(result.posts.map((p) => p.id)).toEqual(["30", "29", "28", "27"])
  })

  it("collects all pages when no cursor is set", () => {
    const result = accumulatePostsUntilCursor({
      batches: [[post("2"), post("1")], [post("0")]],
    })
    expect(result.hitCursor).toBe(false)
    expect(result.newestPostId).toBe("2")
    expect(result.posts.map((p) => p.id)).toEqual(["2", "1", "0"])
  })

  it("returns empty when the first post is already the cursor", () => {
    const result = accumulatePostsUntilCursor({
      batches: [[post("9"), post("8")]],
      stopAtPostId: "9",
    })
    expect(result.hitCursor).toBe(true)
    expect(result.posts).toEqual([])
    expect(result.newestPostId).toBe("9")
  })
})

describe("shouldRetryEmptyTimeline", () => {
  it("retries home empty without cursor (hydration / For you miss)", () => {
    expect(shouldRetryEmptyTimeline({
      kind: "home",
      postCount: 0,
      hitCursor: false,
    })).toBe(true)
  })

  it("does not retry true idle (cursor hit, no new posts)", () => {
    expect(shouldRetryEmptyTimeline({
      kind: "home",
      postCount: 0,
      hitCursor: true,
    })).toBe(false)
  })

  it("does not retry when posts were parsed", () => {
    expect(shouldRetryEmptyTimeline({
      kind: "home",
      postCount: 3,
      hitCursor: false,
    })).toBe(false)
  })
})
