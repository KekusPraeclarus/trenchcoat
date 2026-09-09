import { describe, expect, it, vi } from "vitest"
import type { Locator, Page } from "playwright"
import {
  accumulatePostsUntilCursor,
} from "../../src/collectors/twitter/scrape-cursor.js"
import {
  ensureHomeForYouTab,
  findHomeForYouTab,
  homeForYouTabCandidates,
  shouldRetryEmptyTimeline,
} from "../../src/collectors/twitter/scrape.js"

function emptyLocator(): Locator {
  return {
    count: async () => 0,
    first() { return this as Locator },
    filter: () => emptyLocator(),
  } as unknown as Locator
}

function mockHomePage(args: Readonly<{
  tabCount: () => Promise<number>
  linkCount?: () => Promise<number>
  hasTextCount?: () => Promise<number>
  ariaSelected?: string | null
  click?: () => Promise<void>
}>): Page {
  const tabHandle = {
    kind: "tab" as const,
    count: args.tabCount,
    first() { return this },
    getAttribute: async (name: string) => (
      name === "aria-selected" ? (args.ariaSelected ?? null) : null
    ),
    click: args.click ?? (async () => undefined),
  }
  const linkHandle = {
    kind: "link" as const,
    count: args.linkCount ?? (async () => 0),
    first() { return this },
    getAttribute: async () => null,
    click: async () => undefined,
  }
  const hasTextHandle = {
    kind: "hasText" as const,
    count: args.hasTextCount ?? (async () => 0),
    first() { return this },
    getAttribute: async () => null,
    click: async () => undefined,
  }
  const column = {
    waitFor: async () => undefined,
    first() { return this },
    getByRole: (role: string) => {
      if (role === "tab") return tabHandle
      if (role === "link") return linkHandle
      return emptyLocator()
    },
    locator: (sel: string) => {
      if (sel === "[role=tab]") {
        return { filter: () => hasTextHandle }
      }
      return emptyLocator()
    },
  }
  return {
    locator: (sel: string) => {
      if (sel === '[data-testid="primaryColumn"]') return column
      return emptyLocator()
    },
    waitForTimeout: async () => undefined,
  } as unknown as Page
}

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

describe("homeForYouTabCandidates", () => {
  it("orders candidates tab → link → hasText", () => {
    const order: string[] = []
    const column = {
      getByRole: (role: string) => {
        order.push(`role:${role}`)
        return emptyLocator()
      },
      locator: (sel: string) => {
        order.push(`locator:${sel}`)
        return {
          filter: () => {
            order.push("hasText")
            return emptyLocator()
          },
        }
      },
    } as unknown as Locator
    const candidates = homeForYouTabCandidates(column)
    expect(candidates).toHaveLength(3)
    expect(order).toEqual(["role:tab", "role:link", "locator:[role=tab]", "hasText"])
  })
})

describe("findHomeForYouTab", () => {
  it("prefers tab over link over hasText", async () => {
    const viaLink = await findHomeForYouTab(mockHomePage({
      tabCount: async () => 0,
      linkCount: async () => 1,
      hasTextCount: async () => 1,
    }))
    expect((viaLink as { kind?: string } | null)?.kind).toBe("link")

    const viaHasText = await findHomeForYouTab(mockHomePage({
      tabCount: async () => 0,
      linkCount: async () => 0,
      hasTextCount: async () => 1,
    }))
    expect((viaHasText as { kind?: string } | null)?.kind).toBe("hasText")

    const viaTab = await findHomeForYouTab(mockHomePage({
      tabCount: async () => 1,
      linkCount: async () => 1,
      hasTextCount: async () => 1,
    }))
    expect((viaTab as { kind?: string } | null)?.kind).toBe("tab")
  })
})

describe("ensureHomeForYouTab", () => {
  it("polls until For you tab hydrates then clicks once", async () => {
    let finds = 0
    const click = vi.fn(async () => undefined)
    const page = mockHomePage({
      tabCount: async () => {
        finds += 1
        return finds >= 2 ? 1 : 0
      },
      ariaSelected: "false",
      click,
    })
    await ensureHomeForYouTab(page)
    expect(finds).toBeGreaterThanOrEqual(2)
    expect(click).toHaveBeenCalledTimes(1)
  })

  it("skips click when aria-selected is true", async () => {
    const click = vi.fn(async () => undefined)
    const page = mockHomePage({
      tabCount: async () => 1,
      ariaSelected: "true",
      click,
    })
    await ensureHomeForYouTab(page)
    expect(click).not.toHaveBeenCalled()
  })

  it("warns without click when tab never appears", async () => {
    const click = vi.fn(async () => undefined)
    const page = mockHomePage({
      tabCount: async () => 0,
      linkCount: async () => 0,
      hasTextCount: async () => 0,
      click,
    })
    await ensureHomeForYouTab(page)
    expect(click).not.toHaveBeenCalled()
  })
})
