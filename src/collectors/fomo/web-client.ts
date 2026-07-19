import { randomBytes } from "node:crypto"
import { chromium, type Browser, type BrowserContext, type Page, type Response } from "playwright"
import { assertFomoProfileReady, fomoProfileDir } from "../social/fomo-auth.js"
import { classifyFomoRequest, type FomoAllowedPost } from "./request-policy.js"
import {
  completeAttempt,
  loadUsageDay,
  remainingBudget,
  reserveAttempt,
  saveUsageDay,
} from "./usage.js"
import {
  expandFeedItems,
  extractArrayPayload,
  mapAlertEvent,
  mapLeaderboardEntry,
  mapThesis,
  mapTradeEvent,
  mapTrendingObservation,
} from "./mappers.js"
import { FomoClientError, type FomoAlertEvent, type FomoLeaderboardEntry, type FomoThesis, type FomoTradeEvent, type FomoTrendingObservation } from "./types.js"

/** Stable boot route so SPA loads leaderboard/feed/trending APIs */
const FOMO_BOOT_PATH = "/tokens/solana/2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv"

export type FomoWebClientOptions = Readonly<{
  archiveRoot: string
  dailyNavigationBudget?: number
  minDelayMs?: number
  maxDelayMs?: number
  navigationTimeoutMs?: number
  maxPayloadBytes?: number
  allowedPosts?: readonly FomoAllowedPost[]
  headless?: boolean
  nowIso?: () => string
  sleep?: (ms: number) => Promise<void>
  debitAttempts?: boolean
  bootPath?: string
}>

type CapturedJson = Readonly<{ url: string, status: number, body: unknown }>

function requestId(): string {
  return `req-${randomBytes(8).toString("hex")}`
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function timeframePath(timeframe: "24h" | "7d" | "30d" | "all"): string {
  if (timeframe === "all") return "/v2/leaderboard"
  return `/v2/leaderboard/${timeframe}`
}

export class FomoWebClient {
  private readonly opts: FomoWebClientOptions
  private readonly budget: number
  private browser: Browser | undefined
  private context: BrowserContext | undefined

  constructor(opts: FomoWebClientOptions) {
    this.opts = opts
    this.budget = opts.dailyNavigationBudget ?? 200
  }

  private nowIso(): string {
    return this.opts.nowIso?.() ?? new Date().toISOString()
  }

  private dayKey(iso = this.nowIso()): string {
    return iso.slice(0, 10)
  }

  async remainingToday(): Promise<number> {
    const day = loadUsageDay(this.opts.archiveRoot, this.dayKey(), this.budget)
    return remainingBudget(day)
  }

  private async openContext(): Promise<BrowserContext> {
    if (this.context) return this.context
    assertFomoProfileReady(fomoProfileDir())
    this.browser = await chromium.launch({
      headless: this.opts.headless !== false,
      args: ["--disable-blink-features=AutomationControlled"],
    })
    this.context = await this.browser.newContext({
      storageState: assertFomoProfileReady(),
      viewport: { width: 1440, height: 900 },
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    })
    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined })
    })
    await this.context.route("**/*", async (route) => {
      const request = route.request()
      const decision = classifyFomoRequest(request.method(), request.url(), {
        ...(this.opts.allowedPosts ? { allowedPosts: this.opts.allowedPosts } : {}),
      })
      if (!decision.allow) {
        await route.abort("blockedbyclient")
        return
      }
      await route.continue()
    })
    return this.context
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => undefined)
    await this.browser?.close().catch(() => undefined)
    this.context = undefined
    this.browser = undefined
  }

  private async withDebit<T>(
    family: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const debit = this.opts.debitAttempts !== false
    let day = loadUsageDay(this.opts.archiveRoot, this.dayKey(), this.budget)
    let attemptId: string | undefined
    if (debit) {
      try {
        const reserved = reserveAttempt(day, {
          requestId: requestId(),
          endpointFamily: family,
          at: this.nowIso(),
          counted: true,
        })
        day = reserved.day
        attemptId = reserved.attemptId
        await saveUsageDay(this.opts.archiveRoot, day)
      } catch {
        throw new FomoClientError("budget_exhausted", "fomo daily navigation budget exhausted")
      }
    }
    try {
      const value = await run()
      if (debit && attemptId) {
        day = completeAttempt(day, {
          attemptId,
          ok: true,
          counted: true,
          at: this.nowIso(),
        })
        await saveUsageDay(this.opts.archiveRoot, day)
      }
      return value
    } catch (error) {
      if (debit && attemptId) {
        day = completeAttempt(day, {
          attemptId,
          ok: false,
          counted: true,
          at: this.nowIso(),
        })
        await saveUsageDay(this.opts.archiveRoot, day)
      }
      throw error
    }
  }

  private async pace(): Promise<void> {
    const min = this.opts.minDelayMs ?? 1_500
    const max = Math.max(min, this.opts.maxDelayMs ?? 3_500)
    const delay = min + Math.floor(Math.random() * (max - min + 1))
    await (this.opts.sleep ?? defaultSleep)(delay)
  }

  private detectChallenge(page: Page): void {
    const url = page.url()
    if (/challenge|cloudflare|cdn-cgi\/challenge/iu.test(url)) {
      throw new FomoClientError("challenged", "Fomo challenge page detected")
    }
    if (/login|signin|privy/iu.test(url) && !/prod-api/iu.test(url)) {
      // soft signal; confirmed via missing JSON below
    }
  }

  private async navigateAndCapture(
    family: string,
    path: string,
    match: (url: string) => boolean,
    waitMs = 8_000,
  ): Promise<CapturedJson[]> {
    return this.withDebit(family, async () => {
      await this.pace()
      const context = await this.openContext()
      const page = await context.newPage()
      const hits: CapturedJson[] = []
      const maxBytes = this.opts.maxPayloadBytes ?? 1_000_000
      const onResponse = async (response: Response) => {
        try {
          if (!match(response.url())) return
          const headers = response.headers()
          const type = headers["content-type"] ?? ""
          if (!/json/iu.test(type) && !response.url().includes("prod-api.fomo.family")) return
          const buffer = await response.body()
          if (buffer.byteLength > maxBytes) {
            throw new FomoClientError("size_limit", `payload exceeds ${maxBytes} bytes`)
          }
          const text = buffer.toString("utf8")
          hits.push({
            url: response.url(),
            status: response.status(),
            body: JSON.parse(text) as unknown,
          })
        } catch (error) {
          if (error instanceof FomoClientError) throw error
          // ignore non-JSON
        }
      }
      page.on("response", onResponse)
      try {
        const response = await page.goto(`https://fomo.family${path}`, {
          waitUntil: "domcontentloaded",
          timeout: this.opts.navigationTimeoutMs ?? 45_000,
        })
        this.detectChallenge(page)
        if (response && (response.status() === 401 || response.status() === 403)) {
          throw new FomoClientError("session_expired", "Fomo session expired", response.status())
        }
        await page.waitForTimeout(waitMs)
        this.detectChallenge(page)
        const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 400) ?? "")
        if (/sign in|log in|login/iu.test(bodyText) && !/leaderboard|feed|trending|prices|alerts|watchlist/iu.test(bodyText)) {
          throw new FomoClientError("session_expired", "Fomo login wall detected")
        }
        if (hits.some((hit) => hit.status === 401 || hit.status === 403)) {
          throw new FomoClientError("session_expired", "Fomo API unauthorized")
        }
        return hits
      } finally {
        page.off("response", onResponse)
        await page.close().catch(() => undefined)
      }
    })
  }

  private firstArray(hits: readonly CapturedJson[], keys: readonly string[]): unknown[] {
    for (const hit of hits) {
      const items = extractArrayPayload(hit.body, keys)
      if (items.length > 0) return items
      if (Array.isArray(hit.body)) return hit.body
    }
    for (const hit of hits) {
      if (hit.status >= 200 && hit.status < 300) {
        return extractArrayPayload(hit.body, keys)
      }
    }
    return []
  }

  async readLeaderboard(args: Readonly<{
    timeframe?: "24h" | "7d" | "30d" | "all"
    limit?: number
  }> = {}): Promise<FomoLeaderboardEntry[]> {
    const observedAt = this.nowIso()
    const timeframe = args.timeframe ?? "7d"
    const apiPath = timeframePath(timeframe)
    const hits = await this.navigateAndCapture(
      "leaderboard",
      this.opts.bootPath ?? FOMO_BOOT_PATH,
      (url) => {
        try {
          const parsed = new URL(url)
          if (parsed.hostname !== "prod-api.fomo.family") return false
          return timeframe === "all"
            ? parsed.pathname === "/v2/leaderboard"
            : parsed.pathname === apiPath
        } catch {
          return false
        }
      },
    )
    const items = this.firstArray(hits, ["leaderboard", "traders", "data", "items", "users"])
    return items
      .map((item) => mapLeaderboardEntry(item, observedAt, timeframe))
      .filter((item): item is FomoLeaderboardEntry => Boolean(item))
      .slice(0, args.limit ?? 50)
  }

  async readFeed(args: Readonly<{ limit?: number }> = {}): Promise<FomoTradeEvent[]> {
    const observedAt = this.nowIso()
    const hits = await this.navigateAndCapture(
      "feed",
      this.opts.bootPath ?? FOMO_BOOT_PATH,
      (url) => /prod-api\.fomo\.family\/feed\/tradingActivity/iu.test(url),
    )
    const items = this.firstArray(hits, ["items", "feed", "activity", "trades", "data"])
    const events = items.flatMap((item) => expandFeedItems(item, observedAt))
    if (events.length === 0) {
      return items
        .map((item) => mapTradeEvent(item, observedAt))
        .filter((item): item is FomoTradeEvent => Boolean(item))
        .slice(0, args.limit ?? 100)
    }
    return events.slice(0, args.limit ?? 100)
  }

  async readTrending(args: Readonly<{ limit?: number }> = {}): Promise<FomoTrendingObservation[]> {
    const observedAt = this.nowIso()
    const hits = await this.navigateAndCapture(
      "trending",
      this.opts.bootPath ?? FOMO_BOOT_PATH,
      (url) => /prod-api\.fomo\.family\/proxy\/(trendingTokens|mostHeld)/iu.test(url),
    )
    const items = this.firstArray(hits, ["tokens", "trending", "data", "items", "responseObject"])
    // mostHeld returns responseObject as array directly
    const list = items.length > 0 ? items : hits.flatMap((hit) => extractArrayPayload(hit.body, ["responseObject"]))
    return list
      .map((item, index) => mapTrendingObservation(item, observedAt, index + 1))
      .filter((item): item is FomoTrendingObservation => Boolean(item))
      .slice(0, args.limit ?? 10)
  }

  async readAlerts(args: Readonly<{ limit?: number }> = {}): Promise<FomoAlertEvent[]> {
    const observedAt = this.nowIso()
    const hits = await this.navigateAndCapture(
      "alerts",
      this.opts.bootPath ?? FOMO_BOOT_PATH,
      (url) => /prod-api\.fomo\.family\/.*(alert|notification)/iu.test(url),
    )
    const items = this.firstArray(hits, ["alerts", "data", "items"])
    return items
      .map((item) => mapAlertEvent(item, observedAt))
      .filter((item): item is FomoAlertEvent => Boolean(item))
      .slice(0, args.limit ?? 100)
  }

  async readProfile(handle: string): Promise<FomoLeaderboardEntry | undefined> {
    const observedAt = this.nowIso()
    const safe = encodeURIComponent(handle.trim().replace(/^@/u, ""))
    const hits = await this.navigateAndCapture(
      "profile",
      `/profile/${safe}`,
      (url) => /prod-api\.fomo\.family\/v2\/users/iu.test(url),
    )
    const items = this.firstArray(hits, ["user", "profile", "trader", "data", "items", "responseObject"])
    const first = items[0] ?? (() => {
      for (const hit of hits) {
        if (hit.body && typeof hit.body === "object" && "responseObject" in (hit.body as object)) {
          return Reflect.get(hit.body as object, "responseObject")
        }
      }
      return hits[0]?.body
    })()
    return first ? mapLeaderboardEntry({
      ...(typeof first === "object" && first ? first as object : {}),
      userHandle: handle,
    }, observedAt) : undefined
  }

  async readTokenPage(chain: string, tokenAddress: string): Promise<{
    theses: FomoThesis[]
    trades: FomoTradeEvent[]
  }> {
    const observedAt = this.nowIso()
    const hits = await this.navigateAndCapture(
      "token",
      `/tokens/${encodeURIComponent(chain)}/${encodeURIComponent(tokenAddress)}`,
      (url) => /token|thesis|trade/iu.test(url),
    )
    const theses = this.firstArray(hits, ["theses", "thesis", "data", "items"])
      .map((item) => mapThesis(item, observedAt))
      .filter((item): item is FomoThesis => Boolean(item))
    const trades = this.firstArray(hits, ["trades", "activity", "feed", "items"])
      .map((item) => mapTradeEvent(item, observedAt))
      .filter((item): item is FomoTradeEvent => Boolean(item))
    return { theses, trades }
  }

  /** Compatibility aliases used by existing orchestrators during migration */
  async getLeaderboard(args: Readonly<{
    timeframe?: "24h" | "7d" | "30d" | "all"
    limit?: number
  }> = {}): Promise<FomoLeaderboardEntry[]> {
    return this.readLeaderboard(args)
  }

  async getTrendingHandles(): Promise<string[]> {
    const trending = await this.readTrending({ limit: 20 })
    return []
  }

  async getHandleStats(handle: string): Promise<FomoLeaderboardEntry | undefined> {
    return this.readProfile(handle)
  }

  async getHotTokens(args: Readonly<{ hours?: number, limit?: number }> = {}): Promise<FomoTrendingObservation[]> {
    return this.readTrending({ limit: args.limit ?? 10 })
  }

  async getActivity(): Promise<FomoTradeEvent[]> {
    return this.readFeed()
  }

  async pollActivity(): Promise<Readonly<{ count: number, latestAt?: string }>> {
    const feed = await this.readFeed({ limit: 20 })
    const latestAt = feed
      .map((item) => item.eventAt)
      .sort()
      .at(-1)
    return {
      count: feed.length,
      ...(latestAt ? { latestAt } : {}),
    }
  }

  async getConvergence(): Promise<never[]> {
    return []
  }
}

export type FomoDataSource = Pick<
  FomoWebClient,
  | "readLeaderboard"
  | "readFeed"
  | "readTrending"
  | "readAlerts"
  | "readProfile"
  | "getLeaderboard"
  | "getTrendingHandles"
  | "getHandleStats"
  | "getHotTokens"
  | "getActivity"
  | "pollActivity"
  | "getConvergence"
  | "remainingToday"
  | "close"
>
