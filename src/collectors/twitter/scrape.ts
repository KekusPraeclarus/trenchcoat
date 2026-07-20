import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { chromium, type Browser, type BrowserContext, type Page } from "playwright"
import type { TrenchcoatConfig } from "../../lib/config.js"
import type { CanonicalIdentity } from "../../contracts/schemas.js"
import { twitterProfileDir } from "../social/twitter-auth.js"
import { parseTwitterSearchPage, type TwitterPost } from "../twitter/session.js"
import {
  buildResearchTwitterQueries,
  summarizeTwitterPopularity,
  twitterSearchUrl,
  type TwitterPopularitySummary,
} from "./popularity.js"
import { accumulatePostsUntilCursor } from "./scrape-cursor.js"
import { log } from "../../lib/log.js"

/** Playwright mid-scrape death — page/context/browser closed under us */
export function isBrowserClosedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /Target (?:page|context|browser) has been closed|browser has been closed/iu.test(message)
}

export type TwitterScrapeTarget = Readonly<{
  kind: "home" | "operator-list" | "managed-list" | "token-search"
  url: string
  label: string
}>

export type TwitterScrapeBundle = Readonly<{
  target: TwitterScrapeTarget
  posts: readonly TwitterPost[]
  challenged: boolean
}>

export type ResearchTwitterScrapeResult = Readonly<{
  bundles: readonly TwitterScrapeBundle[]
  posts: readonly TwitterPost[]
  popularity: TwitterPopularitySummary
  challenged: boolean
}>

function storageStatePath(): string {
  return join(twitterProfileDir(), "storage-state.json")
}

export function assertTwitterSessionReady(): string {
  const state = storageStatePath()
  if (!existsSync(state)) {
    throw new Error("No X session — run `pnpm dev:cli auth twitter` first")
  }
  return state
}

export function resolveTwitterTargets(config: TrenchcoatConfig): TwitterScrapeTarget[] {
  const targets: TwitterScrapeTarget[] = []
  if (config.twitter.scrape_home) {
    targets.push({
      kind: "home",
      url: "https://x.com/home",
      label: "home/fyp",
    })
  }
  for (const [index, url] of config.twitter.operator_list_urls.entries()) {
    targets.push({
      kind: "operator-list",
      url,
      label: `operator-list-${index + 1}`,
    })
  }
  if (config.twitter.managed_list.list_url) {
    targets.push({
      kind: "managed-list",
      url: config.twitter.managed_list.list_url,
      label: "managed-list",
    })
  }
  if (targets.length === 0) {
    throw new Error(
      "No Twitter targets configured",
    )
  }
  return targets
}

async function detectChallenge(page: Page): Promise<boolean> {
  const url = page.url()
  if (/\/i\/flow\/login|\/account\/access|challenge/iu.test(url)) return true
  const login = await page.locator('input[name="text"], input[autocomplete="username"]').count().catch(() => 0)
  const home = await page.locator('[data-testid="AppTabBar_Home_Link"]').count().catch(() => 0)
  return login > 0 && home === 0
}

async function waitForTweetArticles(page: Page, timeoutMs: number): Promise<boolean> {
  try {
    await page.locator("article[data-testid='tweet']").first().waitFor({
      state: "attached",
      timeout: timeoutMs,
    })
    return true
  } catch {
    return false
  }
}

export type TwitterScrapeUntilCursorResult = Readonly<{
  bundle: TwitterScrapeBundle
  /** Top-of-feed post id from this scrape (next cursor after a successful pass) */
  newestPostId?: string
  /** True when stopAtPostId was observed while scrolling */
  hitCursor: boolean
  pagesScrolled: number
}>

export async function scrapeTarget(
  page: Page,
  target: TwitterScrapeTarget,
  maxPages: number,
): Promise<TwitterScrapeBundle> {
  const result = await scrapeTargetUntilCursor(page, target, { maxPages })
  return result.bundle
}

/**
 * Scroll a target until the previously-read post reappears, or maxPages is hit.
 * New posts are those seen before hitting stopAtPostId (cursor post excluded).
 */
export async function scrapeTargetUntilCursor(
  page: Page,
  target: TwitterScrapeTarget,
  opts: Readonly<{
    maxPages: number
    stopAtPostId?: string
  }>,
): Promise<TwitterScrapeUntilCursorResult> {
  await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 60_000 })
  await page.waitForTimeout(2_000 + Math.floor(Math.random() * 1_500))

  if (await detectChallenge(page)) {
    return {
      bundle: { target, posts: [], challenged: true },
      hitCursor: false,
      pagesScrolled: 0,
    }
  }

  // Prefer "For you" tab on home when present
  if (target.kind === "home") {
    const forYou = page.getByRole("tab", { name: /for you/iu })
    if (await forYou.count().catch(() => 0)) {
      await forYou.first().click().catch(() => undefined)
      await page.waitForTimeout(1_500)
    }
  }

  // Token search often hydrates after domcontentloaded — wait before first parse
  if (target.kind === "token-search") {
    await waitForTweetArticles(page, 12_000)
  }

  const seen = new Map<string, TwitterPost>()
  let newestPostId: string | undefined
  let hitCursor = false
  let pagesScrolled = 0
  const stopAt = opts.stopAtPostId?.trim() || undefined
  const batches: TwitterPost[][] = []

  for (let pageIndex = 0; pageIndex < opts.maxPages; pageIndex += 1) {
    const batch = await parseTwitterSearchPage(page)
    batches.push(batch)
    pagesScrolled = pageIndex + 1
    const partial = accumulatePostsUntilCursor({
      batches,
      ...(stopAt ? { stopAtPostId: stopAt } : {}),
    })
    hitCursor = partial.hitCursor
    newestPostId = partial.newestPostId
    seen.clear()
    for (const post of partial.posts) seen.set(post.id, post)
    if (hitCursor) break
    await page.mouse.wheel(0, 2_800)
    await page.waitForTimeout(1_200 + Math.floor(Math.random() * 1_800))
  }

  // One soft retry: empty Latest/Top timelines are often a hydration race, not "no posts"
  if (target.kind === "token-search" && seen.size === 0) {
    await page.waitForTimeout(2_500)
    if (await waitForTweetArticles(page, 10_000)) {
      const batch = await parseTwitterSearchPage(page)
      batches.push(batch)
      const partial = accumulatePostsUntilCursor({
        batches,
        ...(stopAt ? { stopAtPostId: stopAt } : {}),
      })
      hitCursor = partial.hitCursor
      newestPostId = partial.newestPostId
      seen.clear()
      for (const post of partial.posts) seen.set(post.id, post)
    }
  }

  return {
    bundle: {
      target,
      posts: [...seen.values()],
      challenged: false,
    },
    ...(newestPostId ? { newestPostId } : {}),
    hitCursor,
    pagesScrolled,
  }
}

async function attachReadOnlyRoutes(context: BrowserContext): Promise<void> {
  await context.route("**/*", async (route) => {
    const method = route.request().method().toUpperCase()
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      await route.abort("blockedbyclient")
      return
    }
    await route.continue()
  })
}

async function openReadOnlySession(
  browser: Browser,
  storageState: string,
): Promise<Readonly<{ context: BrowserContext; page: Page }>> {
  const context = await browser.newContext({
    storageState: resolve(storageState),
    viewport: { width: 1280, height: 900 },
  })
  await attachReadOnlyRoutes(context)
  const page = await context.newPage()
  return { context, page }
}

export type PersistentTwitterSession = Readonly<{
  page: () => Page
  close: () => Promise<void>
  relaunch: () => Promise<Page>
}>

/** Keep one authenticated read-only browser alive across round-robin targets */
export async function openPersistentReadOnlyTwitter(
  opts: Readonly<{ headless?: boolean }> = {},
): Promise<PersistentTwitterSession> {
  const state = assertTwitterSessionReady()
  let browser = await chromium.launch({ headless: opts.headless !== false })
  let opened = await openReadOnlySession(browser, state)

  return {
    page: () => opened.page,
    close: async () => {
      await opened.context.close().catch(() => undefined)
      await browser.close().catch(() => undefined)
    },
    relaunch: async () => {
      await opened.context.close().catch(() => undefined)
      await browser.close().catch(() => undefined)
      browser = await chromium.launch({ headless: opts.headless !== false })
      opened = await openReadOnlySession(browser, state)
      return opened.page
    },
  }
}

/**
 * Per-target scrape with one browser relaunch on closed-page death.
 * Returns every successfully completed target (including empty); throws only when none complete.
 */
export async function scrapeTargetsWithRecovery(args: Readonly<{
  targets: readonly TwitterScrapeTarget[]
  maxPages: number
  scrape: (page: Page, target: TwitterScrapeTarget, maxPages: number) => Promise<TwitterScrapeBundle>
  openSession: () => Promise<Readonly<{ page: Page; close: () => Promise<void> }>>
  maxRelaunches?: number
  settleMs?: () => Promise<void>
}>): Promise<TwitterScrapeBundle[]> {
  const maxRelaunches = args.maxRelaunches ?? 1
  let relaunches = 0
  let session = await args.openSession()
  const results: TwitterScrapeBundle[] = []
  const globalSeen = new Set<string>()

  const settle = args.settleMs ?? (async () => {
    await session.page.waitForTimeout(1_000 + Math.floor(Math.random() * 1_000))
  })

  const pushUnique = (bundle: TwitterScrapeBundle): void => {
    const unique = bundle.posts.filter((post) => {
      if (globalSeen.has(post.id)) return false
      globalSeen.add(post.id)
      return true
    })
    results.push({ ...bundle, posts: unique })
  }

  try {
    for (const target of args.targets) {
      log.info("twitter scrape", { target: target.label, url: target.url })
      for (;;) {
        try {
          const bundle = await args.scrape(session.page, target, args.maxPages)
          pushUnique(bundle)
          await settle()
          break
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          const canRelaunch = isBrowserClosedError(error) && relaunches < maxRelaunches
          log.warn("twitter scrape target failed", {
            target: target.label,
            detail,
            relaunch: canRelaunch,
          })
          if (!canRelaunch) break
          relaunches += 1
          await session.close().catch(() => undefined)
          session = await args.openSession()
        }
      }
    }
  } finally {
    await session.close().catch(() => undefined)
  }

  if (results.length === 0) {
    throw new Error("Twitter scrape failed: no targets completed")
  }
  return results
}

/** Live read-only scrape of configured home/FYP + curated list using the burner profile */
export async function scrapeConfiguredTwitter(
  config: TrenchcoatConfig,
  opts: Readonly<{ headless?: boolean }> = {},
): Promise<TwitterScrapeBundle[]> {
  const state = assertTwitterSessionReady()
  const targets = resolveTwitterTargets(config)
  const maxPages = config.twitter.max_pages_per_run

  const browser = await chromium.launch({ headless: opts.headless !== false })
  try {
    return await scrapeTargetsWithRecovery({
      targets,
      maxPages,
      scrape: scrapeTarget,
      openSession: async () => {
        const opened = await openReadOnlySession(browser, state)
        return {
          page: opened.page,
          close: async () => {
            await opened.context.close().catch(() => undefined)
          },
        }
      },
    })
  } finally {
    await browser.close()
  }
}

/**
 * Bounded read-only X search for a resolved research token.
 * Queries are host-built from canonical identity only.
 */
export async function scrapeResearchTokenTwitter(args: Readonly<{
  identity: CanonicalIdentity
  maxPages: number
  maxPosts: number
  fetchedAt: string
  recentWindowHours?: number
  headless?: boolean
}>): Promise<ResearchTwitterScrapeResult> {
  const queries = buildResearchTwitterQueries(args.identity)
  let state: string
  try {
    state = assertTwitterSessionReady()
  } catch (error) {
    return {
      bundles: [],
      posts: [],
      challenged: false,
      popularity: summarizeTwitterPopularity({
        posts: [],
        fetchedAt: args.fetchedAt,
        queriesAttempted: queries.length,
        queriesSucceeded: 0,
        challenged: false,
        unavailableReason: error instanceof Error ? error.message : "X session missing",
        ...(args.recentWindowHours !== undefined
          ? { recentWindowHours: args.recentWindowHours }
          : {}),
      }),
    }
  }

  const browser = await chromium.launch({ headless: args.headless !== false })
  const bundles: TwitterScrapeBundle[] = []
  const globalSeen = new Map<string, TwitterPost>()
  let challenged = false
  let queriesSucceeded = 0

  try {
    const context = await browser.newContext({
      storageState: resolve(state),
      viewport: { width: 1280, height: 900 },
    })
    await context.route("**/*", async (route) => {
      const method = route.request().method().toUpperCase()
      if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
        await route.abort("blockedbyclient")
        return
      }
      await route.continue()
    })

    const page = await context.newPage()
    for (const query of queries) {
      const tabs = ["live", "top"] as const
      let completedWithoutChallenge = false
      for (const tab of tabs) {
        const target: TwitterScrapeTarget = {
          kind: "token-search",
          url: twitterSearchUrl(query.query, tab),
          label: `research-${query.label}-${tab}`,
        }
        log.info("twitter research search", {
          label: target.label,
          query: query.query,
          tab,
        })
        try {
          const bundle = await scrapeTarget(page, target, Math.max(1, args.maxPages))
          if (bundle.challenged) {
            challenged = true
            completedWithoutChallenge = false
            bundles.push({ ...bundle, posts: [] })
            break
          }
          completedWithoutChallenge = true
          const unique = bundle.posts.filter((post) => {
            if (globalSeen.has(post.id)) return false
            globalSeen.set(post.id, post)
            return true
          })
          bundles.push({ ...bundle, posts: unique })
          // Latest empty → try Top once before next host query
          if (bundle.posts.length > 0) break
        } catch (error) {
          log.warn("twitter research search failed", {
            label: target.label,
            detail: error instanceof Error ? error.message : "unknown",
          })
          bundles.push({ target, posts: [], challenged: false })
        }
        await page.waitForTimeout(800 + Math.floor(Math.random() * 800))
      }
      if (completedWithoutChallenge) queriesSucceeded += 1
      await page.waitForTimeout(1_000 + Math.floor(Math.random() * 1_000))
    }
    await context.close()
  } finally {
    await browser.close()
  }

  const posts = [...globalSeen.values()]
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, Math.max(1, args.maxPosts))

  return {
    bundles,
    posts,
    challenged,
    popularity: summarizeTwitterPopularity({
      posts,
      fetchedAt: args.fetchedAt,
      queriesAttempted: queries.length,
      queriesSucceeded,
      challenged,
      ...(args.recentWindowHours !== undefined
        ? { recentWindowHours: args.recentWindowHours }
        : {}),
    }),
  }
}

export function summarizeScrape(bundles: readonly TwitterScrapeBundle[]): unknown {
  return bundles.map((bundle) => ({
    target: bundle.target.label,
    url: bundle.target.url,
    challenged: bundle.challenged,
    count: bundle.posts.length,
    authors: [...new Set(bundle.posts.map((p) => p.author))].slice(0, 20),
    sample: bundle.posts.slice(0, 5).map((p) => ({
      id: p.id,
      author: p.author,
      ts: p.timestamp,
      text: p.text.length > 120 ? `${p.text.slice(0, 117)}…` : p.text,
      url: p.url,
      likes: p.engagement.likes,
      views: p.engagement.views,
    })),
  }))
}
