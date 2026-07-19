import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { randomBytes } from "node:crypto"
import { chromium, type Page } from "playwright"
import { writeAtomicFile } from "../../lib/fs-atomic.js"
import { normalizeXHandle } from "../fomo/mappers.js"
import { twitterProfileDir } from "../social/twitter-auth.js"
import { assertTwitterSessionReady } from "./scrape.js"
import type { TwitterEngagement, TwitterPost } from "./session.js"
import {
  completeAttempt,
  loadUsageDay,
  remainingBudget,
  reserveAttempt,
  saveUsageDay,
} from "./fomo-source-review-usage.js"

export type ProfileHistoryPost = TwitterPost & Readonly<{
  isReply?: boolean
}>

export type ProfileHistoryResult = Readonly<{
  ok: boolean
  posts: readonly ProfileHistoryPost[]
  challenged: boolean
  privateOrSuspended: boolean
  pagesUsed: number
  reason?: string
}>

export type ProfileHistoryProgress = Readonly<{
  schema: 1
  nominationId: string
  collectedPostIds: string[]
  /** Full posts retained so budget-resume can return prior page text, not only IDs */
  posts?: ProfileHistoryPost[]
  oldestTimestamp?: string
  pagesCompleted: number
  status: "in-progress" | "complete" | "budget-exhausted" | "challenged" | "private-or-suspended" | "failed"
  updatedAt: string
}>

type ParsedProfileTweet = {
  id: string
  author: string
  text: string
  timestamp: string
  url: string
  provenance: string
  engagement: TwitterEngagement
  isReply?: boolean
  isRepost?: boolean
}

// Built via Function() so tsx/esbuild cannot inject `__name` into the Playwright browser realm
const parseProfileTweetsInBrowser = new Function("articles", `
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
    const social = (article.querySelector('[data-testid="socialContext"]')?.textContent || "").toLowerCase()
    const isRepost = /\\brepost(ed)?\\b/.test(social)
    const isReply = /\\breplying\\b/.test(social)
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
      ...(isReply ? { isReply: true } : {}),
      ...(isRepost ? { isRepost: true } : {}),
    }]
  })
`) as (articles: Element[]) => ParsedProfileTweet[]

function storageStatePath(): string {
  return join(twitterProfileDir(), "storage-state.json")
}

function progressPath(archiveRoot: string, nominationId: string): string {
  return join(archiveRoot, "fomo-x-source-review", nominationId, "progress.json")
}

function requestId(): string {
  return `req-${randomBytes(8).toString("hex")}`
}

export function resolveXHandleFromFomo(args: Readonly<{
  xProfileUrl?: string
  xHandle?: string
  fomoHandle?: string
  handle?: string
}>): Readonly<{
  xHandle: string
  matchBasis: "fomo-profile-link" | "same-handle"
}> | undefined {
  const fromLink = normalizeXHandle(args.xProfileUrl)
  if (fromLink) return { xHandle: fromLink, matchBasis: "fomo-profile-link" }
  // Callers only pass xHandle when it came from an explicit Fomo profile link
  const fromExplicit = normalizeXHandle(args.xHandle)
  if (fromExplicit) return { xHandle: fromExplicit, matchBasis: "fomo-profile-link" }
  const same = normalizeXHandle(args.fomoHandle ?? args.handle)
  if (!same) return undefined
  return { xHandle: same, matchBasis: "same-handle" }
}

function loadProgress(
  archiveRoot: string,
  nominationId: string,
): ProfileHistoryProgress | undefined {
  const path = progressPath(archiveRoot, nominationId)
  if (!existsSync(path)) return undefined
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as ProfileHistoryProgress
    if (raw.schema !== 1 || raw.nominationId !== nominationId) return undefined
    return raw
  } catch {
    return undefined
  }
}

function oldestTimestamp(posts: readonly ProfileHistoryPost[]): string | undefined {
  let oldest: string | undefined
  let oldestMs = Number.POSITIVE_INFINITY
  for (const post of posts) {
    const ms = Date.parse(post.timestamp)
    if (!Number.isFinite(ms)) continue
    if (ms < oldestMs) {
      oldestMs = ms
      oldest = post.timestamp
    }
  }
  return oldest
}

async function saveProgress(archiveRoot: string, progress: ProfileHistoryProgress): Promise<void> {
  await writeAtomicFile(progressPath(archiveRoot, progress.nominationId), `${JSON.stringify(progress, null, 2)}\n`)
}

async function checkpointProgress(args: Readonly<{
  archiveRoot: string
  nominationId: string
  posts: readonly ProfileHistoryPost[]
  pagesCompleted: number
  status: ProfileHistoryProgress["status"]
  updatedAt: string
}>): Promise<void> {
  const oldest = oldestTimestamp(args.posts)
  await saveProgress(args.archiveRoot, {
    schema: 1,
    nominationId: args.nominationId,
    collectedPostIds: args.posts.map((post) => post.id),
    posts: [...args.posts],
    ...(oldest ? { oldestTimestamp: oldest } : {}),
    pagesCompleted: args.pagesCompleted,
    status: args.status,
    updatedAt: args.updatedAt,
  })
}

async function detectChallenge(page: Page): Promise<boolean> {
  const url = page.url()
  if (/\/i\/flow\/login|\/account\/access|challenge/iu.test(url)) return true
  const login = await page.locator('input[name="text"], input[autocomplete="username"]').count().catch(() => 0)
  const home = await page.locator('[data-testid="AppTabBar_Home_Link"]').count().catch(() => 0)
  return login > 0 && home === 0
}

async function detectPrivateOrSuspended(page: Page): Promise<boolean> {
  const body = await page.locator("body").innerText().catch(() => "")
  if (/account (is )?suspended/iu.test(body)) return true
  if (/this account doesn.?t exist|this account does not exist|account doesn.?t exist/iu.test(body)) return true
  if (/these posts? are protected|this account.?s posts? are protected/iu.test(body)) return true
  return false
}

async function parseProfilePage(page: Page): Promise<ParsedProfileTweet[]> {
  return page.locator("article[data-testid='tweet']").evaluateAll(parseProfileTweetsInBrowser)
}

/**
 * Bounded read-only scrape of `https://x.com/<handle>` with shared page budget
 * and optional per-nomination crash-resume checkpoints.
 */
export async function scrapeProfileHistory(args: Readonly<{
  handle: string
  maxPages: number
  maxPosts: number
  lookbackDays: number
  archiveRoot: string
  fetchedAt: string
  nominationId?: string
  pageBudget?: number
  headless?: boolean
}>): Promise<ProfileHistoryResult> {
  const handle = normalizeXHandle(args.handle)
  if (!handle) {
    return {
      ok: false,
      posts: [],
      challenged: false,
      privateOrSuspended: false,
      pagesUsed: 0,
      reason: "invalid-handle",
    }
  }

  let state: string
  try {
    state = assertTwitterSessionReady()
  } catch (error) {
    return {
      ok: false,
      posts: [],
      challenged: false,
      privateOrSuspended: false,
      pagesUsed: 0,
      reason: error instanceof Error ? error.message : "X session missing",
    }
  }

  const day = args.fetchedAt.slice(0, 10)
  const budget = args.pageBudget ?? 20
  const lookbackMs = args.lookbackDays * 86_400_000
  const fetchedMs = Date.parse(args.fetchedAt)
  const prior = args.nominationId ? loadProgress(args.archiveRoot, args.nominationId) : undefined
  const seen = new Map<string, ProfileHistoryPost>()
  if (prior?.posts) {
    for (const post of prior.posts) {
      if (!seen.has(post.id)) seen.set(post.id, post)
    }
  }
  if (prior) {
    for (const id of prior.collectedPostIds) {
      if (seen.has(id)) continue
      seen.set(id, {
        id,
        author: handle,
        text: "",
        url: `https://x.com/${handle}/status/${id}`,
        timestamp: prior.oldestTimestamp ?? args.fetchedAt,
        provenance: `twitter:@${handle}`,
        engagement: {},
      })
    }
  }
  const pagesAlready = prior?.pagesCompleted ?? 0
  const pagesRemaining = Math.max(0, args.maxPages - pagesAlready)
  let pagesUsed = 0
  let challenged = false
  let privateOrSuspended = false
  let stopReason: string | undefined

  const collectedPosts = (): ProfileHistoryPost[] => [...seen.values()]
    .filter((post) => post.text.length > 0)
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, args.maxPosts)

  if (pagesRemaining === 0) {
    return {
      ok: true,
      posts: collectedPosts(),
      challenged: false,
      privateOrSuspended: false,
      pagesUsed: 0,
      reason: "max-pages-already-complete",
    }
  }

  const browser = await chromium.launch({ headless: args.headless !== false })
  try {
    const context = await browser.newContext({
      storageState: resolve(state || storageStatePath()),
      viewport: { width: 1280, height: 900 },
    })
    await context.route("**/*", async (route) => {
      const method = route.request().method().toUpperCase()
      if (!["GET", "HEAD"].includes(method)) {
        await route.abort("blockedbyclient")
        return
      }
      await route.continue()
    })

    const page = await context.newPage()
    const profileUrl = `https://x.com/${handle}`

    for (let pageIndex = 0; pageIndex < pagesRemaining; pageIndex += 1) {
      if (collectedPosts().length >= args.maxPosts) break

      let usage = loadUsageDay(args.archiveRoot, day, budget)
      if (remainingBudget(usage) <= 0) {
        stopReason = "budget-exhausted"
        if (args.nominationId) {
          await checkpointProgress({
            archiveRoot: args.archiveRoot,
            nominationId: args.nominationId,
            posts: collectedPosts(),
            pagesCompleted: pagesAlready + pagesUsed,
            status: "budget-exhausted",
            updatedAt: args.fetchedAt,
          })
        }
        break
      }

      let attemptId: string
      try {
        const reserved = reserveAttempt(usage, {
          requestId: requestId(),
          endpointFamily: "profile-history",
          at: args.fetchedAt,
          counted: true,
        })
        usage = reserved.day
        attemptId = reserved.attemptId
        await saveUsageDay(args.archiveRoot, usage)
      } catch {
        stopReason = "budget-exhausted"
        if (args.nominationId) {
          await checkpointProgress({
            archiveRoot: args.archiveRoot,
            nominationId: args.nominationId,
            posts: collectedPosts(),
            pagesCompleted: pagesAlready + pagesUsed,
            status: "budget-exhausted",
            updatedAt: args.fetchedAt,
          })
        }
        break
      }

      try {
        if (pageIndex === 0) {
          await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 60_000 })
          await page.waitForTimeout(2_000 + Math.floor(Math.random() * 1_500))
        } else {
          await page.mouse.wheel(0, 2_800)
          await page.waitForTimeout(1_200 + Math.floor(Math.random() * 1_800))
        }

        if (await detectChallenge(page)) {
          challenged = true
          stopReason = "challenged"
          usage = completeAttempt(usage, {
            attemptId,
            ok: false,
            counted: true,
            at: new Date().toISOString(),
          })
          await saveUsageDay(args.archiveRoot, usage)
          pagesUsed += 1
          if (args.nominationId) {
            await checkpointProgress({
              archiveRoot: args.archiveRoot,
              nominationId: args.nominationId,
              posts: collectedPosts(),
              pagesCompleted: pagesAlready + pagesUsed,
              status: "challenged",
              updatedAt: args.fetchedAt,
            })
          }
          break
        }

        if (pageIndex === 0 && await detectPrivateOrSuspended(page)) {
          privateOrSuspended = true
          stopReason = "private-or-suspended"
          usage = completeAttempt(usage, {
            attemptId,
            ok: false,
            counted: true,
            at: new Date().toISOString(),
          })
          await saveUsageDay(args.archiveRoot, usage)
          pagesUsed += 1
          if (args.nominationId) {
            await checkpointProgress({
              archiveRoot: args.archiveRoot,
              nominationId: args.nominationId,
              posts: collectedPosts(),
              pagesCompleted: pagesAlready + pagesUsed,
              status: "private-or-suspended",
              updatedAt: args.fetchedAt,
            })
          }
          break
        }

        const batch = await parseProfilePage(page)
        let hitLookback = false
        for (const raw of batch) {
          if (raw.isRepost) continue
          if (seen.has(raw.id) && seen.get(raw.id)!.text.length > 0) continue
          const ts = Date.parse(raw.timestamp)
          if (Number.isFinite(ts) && Number.isFinite(fetchedMs) && fetchedMs - ts > lookbackMs) {
            hitLookback = true
            continue
          }
          const post: ProfileHistoryPost = {
            id: raw.id,
            author: raw.author.toLowerCase(),
            text: raw.text,
            url: raw.url,
            timestamp: raw.timestamp,
            provenance: `twitter:@${raw.author.toLowerCase()}`,
            engagement: raw.engagement,
            ...(raw.isReply ? { isReply: true } : {}),
          }
          seen.set(post.id, post)
          if (collectedPosts().length >= args.maxPosts) break
        }

        usage = completeAttempt(usage, {
          attemptId,
          ok: true,
          counted: true,
          at: new Date().toISOString(),
        })
        await saveUsageDay(args.archiveRoot, usage)
        pagesUsed += 1

        const collected = collectedPosts()
        if (args.nominationId) {
          await checkpointProgress({
            archiveRoot: args.archiveRoot,
            nominationId: args.nominationId,
            posts: collected,
            pagesCompleted: pagesAlready + pagesUsed,
            status: hitLookback || collected.length >= args.maxPosts ? "complete" : "in-progress",
            updatedAt: args.fetchedAt,
          })
        }

        if (hitLookback || collected.length >= args.maxPosts) break
      } catch (error) {
        usage = completeAttempt(usage, {
          attemptId,
          ok: false,
          counted: true,
          at: new Date().toISOString(),
        })
        await saveUsageDay(args.archiveRoot, usage)
        pagesUsed += 1
        stopReason = error instanceof Error ? error.message : "scrape-failed"
        if (args.nominationId) {
          await checkpointProgress({
            archiveRoot: args.archiveRoot,
            nominationId: args.nominationId,
            posts: collectedPosts(),
            pagesCompleted: pagesAlready + pagesUsed,
            status: "failed",
            updatedAt: args.fetchedAt,
          })
        }
        break
      }
    }

    await context.close()
  } finally {
    await browser.close()
  }

  const posts = collectedPosts()

  if (args.nominationId && !challenged && !privateOrSuspended && stopReason !== "budget-exhausted") {
    const failed = Boolean(stopReason && stopReason !== "max-pages-already-complete")
    await checkpointProgress({
      archiveRoot: args.archiveRoot,
      nominationId: args.nominationId,
      posts,
      pagesCompleted: pagesAlready + pagesUsed,
      status: failed ? "failed" : "complete",
      updatedAt: args.fetchedAt,
    })
  }

  if (challenged || privateOrSuspended) {
    return {
      ok: false,
      posts,
      challenged,
      privateOrSuspended,
      pagesUsed,
      ...(stopReason ? { reason: stopReason } : {}),
    }
  }

  return {
    ok: stopReason !== "scrape-failed" && stopReason !== "invalid-handle",
    posts,
    challenged: false,
    privateOrSuspended: false,
    pagesUsed,
    ...(stopReason ? { reason: stopReason } : {}),
  }
}
