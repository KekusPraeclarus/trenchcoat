import { existsSync } from "node:fs"
import { resolve } from "node:path"
import type { Browser, BrowserContext, Page } from "playwright"

export type TwitterSessionConfig = Readonly<{
  profileDirectory: string
  headless?: boolean
}>

export type TwitterEngagement = Readonly<{
  replies?: number
  reposts?: number
  likes?: number
  views?: number
}>

export type TwitterPost = Readonly<{
  id: string
  author: string
  text: string
  url: string
  timestamp: string
  provenance: string
  engagement: TwitterEngagement
}>

export async function openReadOnlyTwitterContext(
  browser: Browser,
  config: TwitterSessionConfig,
): Promise<BrowserContext> {
  const profile = resolve(config.profileDirectory)
  const context = await browser.newContext({ storageState: resolve(profile, "storage-state.json") })
  await context.route("**/*", async (route) => {
    const method = route.request().method().toUpperCase()
    if (!["GET", "HEAD"].includes(method)) await route.abort("blockedbyclient")
    else await route.continue()
  })
  return context
}

/** Parse compact count labels like 1.2K / 3M; missing or unparsable stays undefined */
export function parseTwitterCountLabel(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined
  const cleaned = raw.replace(/,/gu, "").trim().toUpperCase()
  if (!cleaned) return undefined
  const match = cleaned.match(/^(\d+(?:\.\d+)?)([KMB])?$/u)
  if (!match) return undefined
  const base = Number(match[1])
  if (!Number.isFinite(base)) return undefined
  const suffix = match[2]
  const mult = suffix === "K" ? 1_000 : suffix === "M" ? 1_000_000 : suffix === "B" ? 1_000_000_000 : 1
  return Math.round(base * mult)
}

type ParsedTweet = {
  id: string
  author: string
  text: string
  timestamp: string
  url: string
  provenance: string
  engagement: {
    replies?: number
    reposts?: number
    likes?: number
    views?: number
  }
}

// Built via Function() so tsx/esbuild cannot inject `__name` into the Playwright browser realm
const parseTweetsInBrowser = new Function("articles", `
  const parseCompact = (raw) => {
    if (!raw) return undefined
    const cleaned = raw.replace(/,/g, "").trim().toUpperCase()
    if (!cleaned) return undefined
    const match = cleaned.match(/^(\\d+(?:\\.\\d+)?)([KMB])?$/)
    if (!match) return undefined
    const base = Number(match[1])
    if (!Number.isFinite(base)) return undefined
    const suffix = match[2]
    const mult = suffix === "K" ? 1e3 : suffix === "M" ? 1e6 : suffix === "B" ? 1e9 : 1
    return Math.round(base * mult)
  }
  const countFrom = (article, testId) => {
    const btn = article.querySelector('[data-testid="' + testId + '"]')
    if (!btn) return undefined
    const aria = btn.getAttribute("aria-label") || ""
    const fromAria = aria.match(/([\\d,.]+)\\s/)
    if (fromAria) {
      const n = Number(fromAria[1].replace(/,/g, ""))
      if (Number.isFinite(n)) return n
    }
    return parseCompact((btn.textContent || "").trim())
  }
  const viewCount = (article) => {
    const analytics = article.querySelector('a[href*="/analytics"]')
    if (!analytics) return undefined
    const aria = analytics.getAttribute("aria-label") || ""
    const fromAria = aria.match(/([\\d,.]+)\\s/)
    if (fromAria) {
      const n = Number(fromAria[1].replace(/,/g, ""))
      if (Number.isFinite(n)) return n
    }
    return parseCompact((analytics.textContent || "").trim())
  }
  return articles.slice(0, 100).flatMap((article) => {
    const linkEl = article.querySelector("a[href*='/status/']")
    const link = linkEl ? linkEl.getAttribute("href") : null
    const textEl = article.querySelector("[data-testid='tweetText']")
    const text = textEl ? textEl.textContent : null
    const timeEl = article.querySelector("time")
    const timestamp = timeEl ? timeEl.getAttribute("datetime") : null
    const nameEl = article.querySelector("[data-testid='User-Name']")
    const authorMatch = nameEl && nameEl.textContent
      ? nameEl.textContent.match(/@([A-Za-z0-9_]{1,15})/)
      : null
    const author = authorMatch ? authorMatch[1] : null
    const idMatch = link ? link.match(/status\\/(\\d+)/) : null
    const id = idMatch ? idMatch[1] : null
    if (!link || !text || !timestamp || !author || !id) return []
    const replies = countFrom(article, "reply")
    const reposts = countFrom(article, "retweet")
    const likes = countFrom(article, "like")
    const views = viewCount(article)
    const engagement = {}
    if (replies !== undefined) engagement.replies = replies
    if (reposts !== undefined) engagement.reposts = reposts
    if (likes !== undefined) engagement.likes = likes
    if (views !== undefined) engagement.views = views
    return [{
      id: id,
      author: author,
      text: text,
      timestamp: timestamp,
      url: "https://x.com" + link,
      provenance: "twitter:@" + author,
      engagement: engagement,
    }]
  })
`) as (articles: Element[]) => ParsedTweet[]

export async function parseTwitterSearchPage(page: Page): Promise<TwitterPost[]> {
  const parsed = await page.locator("article[data-testid='tweet']").evaluateAll(parseTweetsInBrowser)
  return parsed.map((post) => ({
    id: post.id,
    author: post.author,
    text: post.text,
    timestamp: post.timestamp,
    url: post.url,
    provenance: post.provenance,
    engagement: post.engagement,
  }))
}

export function assertTwitterProfileReady(profileDirectory: string): string {
  const state = resolve(profileDirectory, "storage-state.json")
  if (!existsSync(state)) {
    throw new Error("No X session — run `pnpm dev:cli auth twitter` first")
  }
  return state
}
