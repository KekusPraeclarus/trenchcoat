import { randomBytes } from "node:crypto"
import { type Browser, type BrowserContext, type Page, type Response } from "playwright"
import { launchChromium } from "../../lib/playwright-chromium.js"
import { assertPumpProfileReady, pumpProfileDir } from "../social/pump-auth.js"
import { classifyPumpRequest, type PumpAllowedPost } from "./request-policy.js"
import {
  completeAttempt,
  loadUsageDay,
  remainingBudget,
  reserveAttempt,
  saveUsageDay,
} from "./usage.js"
import {
  describeHandleField,
  extractArrayPayload,
  indexPumpUsernames,
  mapCallerCall,
  mapFeedItem,
  mapLeaderboardEntry,
} from "./mappers.js"
import {
  PumpClientError,
  type PumpCallerProfile,
  type PumpDataSource,
  type PumpFeedItem,
  type PumpFeedTab,
  type PumpLeaderboardEntry,
} from "./types.js"

/** Feed tabs live on the homepage. They are not /board or /news. */
export const PUMP_HOME_PATH = "/"

export const PUMP_FEED_TAB_LABEL: Readonly<Record<PumpFeedTab, string>> = {
  fyp: "For you",
  top: "Top",
  news: "News",
  following: "Following",
}

export type PumpWebClientOptions = Readonly<{
  archiveRoot: string
  dailyNavigationBudget?: number
  minDelayMs?: number
  maxDelayMs?: number
  navigationTimeoutMs?: number
  maxPayloadBytes?: number
  allowedPosts?: readonly PumpAllowedPost[]
  headless?: boolean
  nowIso?: () => string
  sleep?: (ms: number) => Promise<void>
  debitAttempts?: boolean
  maxPagesPerFeed?: number
}>

type CapturedJson = Readonly<{ url: string, status: number, body: unknown }>

export type PumpCaptureHitMeta = Readonly<{
  host: string
  path: string
  status: number
  keys: readonly string[]
  arrayLen: number
  firstItemType: string
  firstItemKeys: readonly string[]
  usernameShape: string
  xUsernameShape: string
}>

export function redactPumpCapturePath(path: string): string {
  return path.replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/gu, ":id")
}

function redactKey(key: string): string {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u.test(key) ? ":id" : key
}

function topKeys(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return []
  return Object.keys(value).slice(0, 16).map(redactKey)
}

function captureMeta(hit: CapturedJson): PumpCaptureHitMeta {
  let parsed: URL
  try {
    parsed = new URL(hit.url)
  } catch {
    parsed = new URL("https://invalid.local/")
  }
  const extracted = extractArrayPayload(hit.body)
  const first = extracted[0]
  const firstRecord = first && typeof first === "object" && !Array.isArray(first)
    ? first as Record<string, unknown>
    : undefined
  return {
    host: parsed.hostname,
    path: redactPumpCapturePath(parsed.pathname),
    status: hit.status,
    keys: topKeys(hit.body),
    arrayLen: extracted.length,
    firstItemType: first === undefined ? "none" : Array.isArray(first) ? "array" : typeof first,
    firstItemKeys: topKeys(first),
    usernameShape: describeHandleField(firstRecord?.["username"]),
    xUsernameShape: describeHandleField(firstRecord?.["xUsername"]),
  }
}

function requestId(): string {
  return `req-${randomBytes(8).toString("hex")}`
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

export class PumpWebClient implements PumpDataSource {
  private readonly opts: PumpWebClientOptions
  private readonly budget: number
  private browser: Browser | undefined
  private context: BrowserContext | undefined
  private captureLog: PumpCaptureHitMeta[] = []

  constructor(opts: PumpWebClientOptions) {
    this.opts = opts
    this.budget = opts.dailyNavigationBudget ?? 200
  }

  private nowIso(): string {
    return this.opts.nowIso?.() ?? new Date().toISOString()
  }

  private dayKey(iso = this.nowIso()): string {
    return iso.slice(0, 10)
  }

  takeCaptureLog(): readonly PumpCaptureHitMeta[] {
    const log = this.captureLog
    this.captureLog = []
    return log
  }

  async remainingToday(): Promise<number> {
    const day = loadUsageDay(this.opts.archiveRoot, this.dayKey(), this.budget)
    return remainingBudget(day)
  }

  private async openContext(): Promise<BrowserContext> {
    if (this.context) return this.context
    assertPumpProfileReady(pumpProfileDir())
    this.browser = await launchChromium({
      headless: this.opts.headless !== false,
      args: ["--disable-blink-features=AutomationControlled"],
    })
    this.context = await this.browser.newContext({
      storageState: assertPumpProfileReady(),
      viewport: { width: 1440, height: 900 },
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    })
    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined })
    })
    await this.context.route("**/*", async (route) => {
      const request = route.request()
      const decision = classifyPumpRequest(request.method(), request.url(), {
        ...(this.opts.allowedPosts ? { allowedPosts: this.opts.allowedPosts } : {}),
      })
      if (!decision.allow) {
        this.recordBlockedPost(request.method(), request.url(), decision.reason)
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
        throw new PumpClientError("budget_exhausted", "pump daily navigation budget exhausted")
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
      throw new PumpClientError("challenged", "pump.fun challenge page detected")
    }
  }

  private recordBlockedPost(method: string, url: string, reason: string): void {
    if (method.toUpperCase() !== "POST") return
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return
    }
    if (!/pump\.fun$/iu.test(parsed.hostname)) return
    if (parsed.pathname.startsWith("/cdn-cgi/")) return
    this.captureLog.push({
      host: parsed.hostname,
      path: redactPumpCapturePath(parsed.pathname),
      status: 0,
      keys: ["blocked", reason.split(":")[0] ?? reason],
      arrayLen: 0,
      firstItemType: "none",
      firstItemKeys: [],
      usernameShape: "empty",
      xUsernameShape: "empty",
    })
  }

  private async clickFeedTab(page: Page, label: string): Promise<void> {
    if (label === PUMP_FEED_TAB_LABEL.fyp) return
    try {
      await page.getByText(label, { exact: true }).first().click({ timeout: 8_000 })
      await page.waitForTimeout(2_500)
    } catch {
      // Homepage JSON still maps if the tab label is missing.
    }
  }

  private async navigateAndCapture(
    family: string,
    path: string,
    match: (url: string) => boolean,
    pages = 1,
    tabLabel?: string,
  ): Promise<CapturedJson[]> {
    return this.withDebit(family, async () => {
      await this.pace()
      const context = await this.openContext()
      const page = await context.newPage()
      const hits: CapturedJson[] = []
      const pending: Promise<void>[] = []
      const maxBytes = this.opts.maxPayloadBytes ?? 1_000_000
      page.on("response", (response) => {
        pending.push((async () => {
          try {
            if (!match(response.url())) return
            const type = response.headers()["content-type"] ?? ""
            if (!/json/iu.test(type) && !/frontend-api/iu.test(response.url())) return
            const buf = await response.body()
            if (buf.length > maxBytes) {
              throw new PumpClientError("size_limit", "pump payload exceeds max_payload_bytes")
            }
            hits.push({
              url: response.url(),
              status: response.status(),
              body: JSON.parse(buf.toString("utf8")) as unknown,
            })
          } catch (error) {
            if (error instanceof PumpClientError) throw error
          }
        })())
      })
      try {
        const timeout = this.opts.navigationTimeoutMs ?? 30_000
        const waitRe = family === "leaderboard"
          ? /pnl-leaderboard|callouts\/leaderboard|users\/batch/iu
          : /coins|mints|feed|callout|profiles\/verified|users\/batch/iu
        const feedWait = page.waitForResponse((response) => (
          /frontend-api-v\d+\.pump\.fun/iu.test(response.url())
          && waitRe.test(response.url())
        ), { timeout }).catch(() => undefined)
        await page.goto(`https://pump.fun${path}`, {
          waitUntil: "domcontentloaded",
          timeout,
        })
        this.detectChallenge(page)
        await feedWait
        if (tabLabel && tabLabel !== PUMP_FEED_TAB_LABEL.fyp) {
          await Promise.all(pending)
          pending.length = 0
          hits.length = 0
          await this.clickFeedTab(page, tabLabel)
          await page.waitForResponse((response) => (
            /frontend-api-v\d+\.pump\.fun/iu.test(response.url())
            && waitRe.test(response.url())
          ), { timeout }).catch(() => undefined)
        }
        const maxPages = Math.max(1, pages)
        for (let i = 0; i < maxPages; i += 1) {
          await page.waitForTimeout(2_500)
          this.detectChallenge(page)
          await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2))
          await page.waitForTimeout(2_000)
        }
        await Promise.all(pending)
      } finally {
        await page.close().catch(() => undefined)
      }
      this.captureLog.push(...hits.map(captureMeta))
      if (hits.some((hit) => hit.status === 401 || hit.status === 403)) {
        throw new PumpClientError("unauthorized", "pump.fun session rejected")
      }
      return hits
    })
  }

  async readFeed(args: Readonly<{
    tab: PumpFeedTab
    cursor?: string
    maxPages?: number
  }>): Promise<readonly PumpFeedItem[]> {
    const pages = args.maxPages ?? this.opts.maxPagesPerFeed ?? 5
    const hits = await this.navigateAndCapture(
      `feed-${args.tab}`,
      PUMP_HOME_PATH,
      (url) => /pump\.fun|frontend-api/iu.test(url),
      pages,
      PUMP_FEED_TAB_LABEL[args.tab],
    )
    const observedAt = this.nowIso()
    const usernames = indexPumpUsernames(hits.flatMap((hit) => extractArrayPayload(hit.body)))
    const items: PumpFeedItem[] = []
    const seen = new Set<string>()
    for (const hit of hits) {
      if (!/coins-v2\/mints|callout\//iu.test(hit.url)) continue
      for (const raw of extractArrayPayload(hit.body)) {
        const mapped = mapFeedItem(raw, args.tab, observedAt, usernames)
        if (!mapped || seen.has(mapped.itemId)) continue
        if (args.cursor && mapped.itemId === args.cursor) return items
        seen.add(mapped.itemId)
        items.push(mapped)
      }
    }
    return items
  }

  async readLeaderboard(args?: Readonly<{
    maxHandles?: number
  }>): Promise<readonly PumpLeaderboardEntry[]> {
    const hits = await this.navigateAndCapture(
      "leaderboard",
      PUMP_HOME_PATH,
      (url) => /pump\.fun|frontend-api/iu.test(url),
      1,
    )
    const observedAt = this.nowIso()
    const usernames = indexPumpUsernames(hits.flatMap((hit) => extractArrayPayload(hit.body)))
    const entries: PumpLeaderboardEntry[] = []
    const seen = new Set<string>()
    let rank = 1
    const boardHits = hits.filter((hit) => /pnl-leaderboard/iu.test(hit.url))
    const source = boardHits.length > 0 ? boardHits : hits
    for (const hit of source) {
      for (const raw of extractArrayPayload(hit.body)) {
        const mapped = mapLeaderboardEntry(raw, observedAt, rank, usernames)
        if (!mapped || seen.has(mapped.handle.toLowerCase())) continue
        seen.add(mapped.handle.toLowerCase())
        entries.push(mapped)
        rank += 1
        if (args?.maxHandles && entries.length >= args.maxHandles) return entries
      }
    }
    return entries
  }

  async readCallerProfile(handle: string): Promise<PumpCallerProfile> {
    const hits = await this.navigateAndCapture(
      "caller-profile",
      `/profile/${encodeURIComponent(handle)}`,
      (url) => /pump\.fun|frontend-api/iu.test(url),
      1,
    )
    const observedAt = this.nowIso()
    const calls = hits.flatMap((hit) => (
      extractArrayPayload(hit.body)
        .map((raw) => mapCallerCall(raw, handle, observedAt))
        .filter((call): call is NonNullable<typeof call> => Boolean(call))
    ))
    return { handle, calls }
  }

  async captureCallChart(_handle: string, _mint: string): Promise<Buffer | undefined> {
    return undefined
  }
}

export type { PumpDataSource }
