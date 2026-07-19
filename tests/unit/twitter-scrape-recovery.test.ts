import { describe, expect, it, vi } from "vitest"
import {
  isBrowserClosedError,
  scrapeTargetsWithRecovery,
  type TwitterScrapeBundle,
  type TwitterScrapeTarget,
} from "../../src/collectors/twitter/scrape.js"
import type { Page } from "playwright"

function target(label: string): TwitterScrapeTarget {
  return { kind: "operator-list", url: `https://x.com/i/lists/${label}`, label }
}

function emptyBundle(t: TwitterScrapeTarget): TwitterScrapeBundle {
  return { target: t, posts: [], challenged: false }
}

describe("isBrowserClosedError", () => {
  it("matches Playwright closed-target messages", () => {
    expect(isBrowserClosedError(
      new Error("locator.evaluateAll: Target page, context or browser has been closed"),
    )).toBe(true)
    expect(isBrowserClosedError(new Error("browser has been closed"))).toBe(true)
    expect(isBrowserClosedError(new Error("timeout waiting for selector"))).toBe(false)
  })
})

describe("scrapeTargetsWithRecovery", () => {
  it("relaunches once after browser-closed and scrapes remaining targets", async () => {
    const targets = [target("a"), target("b"), target("c")]
    let sessions = 0
    let aAttempts = 0
    const scrape = vi.fn(async (_page: Page, t: TwitterScrapeTarget) => {
      if (t.label === "a") {
        aAttempts += 1
        if (aAttempts === 1) {
          throw new Error("locator.evaluateAll: Target page, context or browser has been closed")
        }
      }
      return emptyBundle(t)
    })

    const results = await scrapeTargetsWithRecovery({
      targets,
      maxPages: 1,
      scrape,
      openSession: async () => {
        sessions += 1
        return {
          page: {} as Page,
          close: async () => undefined,
        }
      },
      settleMs: async () => undefined,
    })

    expect(sessions).toBe(2)
    expect(results.map((r) => r.target.label)).toEqual(["a", "b", "c"])
    expect(aAttempts).toBe(2)
  })

  it("skips a dead target after relaunch budget is spent and continues", async () => {
    const targets = [target("a"), target("b")]
    let sessions = 0
    const scrape = vi.fn(async (_page: Page, t: TwitterScrapeTarget) => {
      if (t.label === "a") {
        throw new Error("Target page, context or browser has been closed")
      }
      return emptyBundle(t)
    })

    const results = await scrapeTargetsWithRecovery({
      targets,
      maxPages: 1,
      scrape,
      openSession: async () => {
        sessions += 1
        return { page: {} as Page, close: async () => undefined }
      },
      settleMs: async () => undefined,
    })

    expect(sessions).toBe(2)
    expect(results.map((r) => r.target.label)).toEqual(["b"])
  })

  it("throws when every target fails", async () => {
    await expect(scrapeTargetsWithRecovery({
      targets: [target("a")],
      maxPages: 1,
      scrape: async () => {
        throw new Error("timeout")
      },
      openSession: async () => ({ page: {} as Page, close: async () => undefined }),
      settleMs: async () => undefined,
    })).rejects.toThrow(/no targets completed/u)
  })
})
