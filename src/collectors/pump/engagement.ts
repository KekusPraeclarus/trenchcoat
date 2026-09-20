import { type Browser, type BrowserContext, type Locator, type Page, type Response } from "playwright"
import { launchChromium } from "../../lib/playwright-chromium.js"
import { assertPumpProfileReady, pumpProfileDir } from "../social/pump-auth.js"
import { classifyPumpRequest } from "./request-policy.js"
import { PumpClientError } from "./types.js"

const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/u
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u
const LIKE_POST_RE = /\/(like|unlike)(\/|$)/iu
const FOLLOW_POST_RE = /\/(follow|unfollow)(\/|$)/iu
const CALLOUT_ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu

export const PUMP_LIKE_TEST_ID = "callout-action-like"

export type PumpEngagementDriver = {
  like(itemId: string): Promise<{ verified: boolean, ambiguous: boolean }>
  follow(handle: string): Promise<{ verified: boolean, ambiguous: boolean }>
  unfollow(handle: string): Promise<{ verified: boolean, ambiguous: boolean }>
  verifyLiked(itemId: string): Promise<boolean>
  verifyFollowing(handle: string): Promise<boolean>
  close(): Promise<void>
}

export type PumpEngagementSessionOptions = Readonly<{
  headless?: boolean
  navigationTimeoutMs?: number
}>

export function pumpItemCardSelectors(itemId: string): readonly string[] {
  if (!SAFE_ID_RE.test(itemId)) return []
  return [
    `a[href*="/callouts/"][href*="${itemId}"]`,
    `[data-item-id="${itemId}"]`,
    `[data-callout-id="${itemId}"]`,
    `[data-coin-id="${itemId}"]`,
    `a[href*="${itemId}"]`,
  ]
}

export function pumpCalloutPermalink(mint: string, itemId: string): string | undefined {
  if (!MINT_RE.test(mint) || !SAFE_ID_RE.test(itemId)) return undefined
  return `https://pump.fun/callouts/${mint}/${itemId}`
}

export function mintFromCalloutJson(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined
  const raw = body as Record<string, unknown>
  const nested = raw["callout"]
  const row = (
    typeof nested === "object" && nested !== null && !Array.isArray(nested)
      ? nested as Record<string, unknown>
      : raw
  )
  const mint = row["coinMint"] ?? row["mint"] ?? row["tokenAddress"]
  return typeof mint === "string" && MINT_RE.test(mint) ? mint : undefined
}

/**
 * Separate mutation session. Collect scrape never uses this.
 * Request policy allows like/follow/unfollow POSTs only here.
 */
export class PumpEngagementSession implements PumpEngagementDriver {
  private readonly opts: PumpEngagementSessionOptions
  private browser: Browser | undefined
  private context: BrowserContext | undefined

  constructor(opts: PumpEngagementSessionOptions = {}) {
    this.opts = opts
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
    })
    await this.context.route("**/*", async (route) => {
      const request = route.request()
      const decision = classifyPumpRequest(request.method(), request.url(), {
        mutationMode: true,
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

  private detectChallenge(page: Page): void {
    if (/challenge|cloudflare|cdn-cgi\/challenge/iu.test(page.url())) {
      throw new PumpClientError("challenged", "pump.fun challenge during engagement")
    }
  }

  private async withPage<T>(run: (page: Page) => Promise<T>): Promise<T> {
    const context = await this.openContext()
    const page = await context.newPage()
    try {
      const timeout = this.opts.navigationTimeoutMs ?? 30_000
      await page.goto("https://pump.fun/", { waitUntil: "domcontentloaded", timeout })
      this.detectChallenge(page)
      await this.dismissBlockingUi(page)
      return await run(page)
    } finally {
      await page.close().catch(() => undefined)
    }
  }

  private async dismissBlockingUi(page: Page): Promise<void> {
    const dialog = page.getByRole("dialog")
    await dialog.getByRole("button", { name: "Continue" }).click({ timeout: 3_000 }).catch(() => undefined)
    await dialog.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => undefined)
    await page.getByRole("button", { name: "Dismiss" }).click({ timeout: 2_000 }).catch(() => undefined)
  }

  private waitForPost(page: Page, pathRe: RegExp): Promise<Response | undefined> {
    return page.waitForResponse((response) => {
      if (response.request().method() !== "POST") return false
      try {
        return pathRe.test(new URL(response.url()).pathname)
      } catch {
        return false
      }
    }, { timeout: 8_000 }).catch(() => undefined)
  }

  private async findItemCard(page: Page, itemId: string): Promise<Locator | undefined> {
    const selectors = pumpItemCardSelectors(itemId)
    for (let i = 0; i < 8; i += 1) {
      for (const selector of selectors) {
        const loc = page.locator(selector).first()
        if (await loc.count().catch(() => 0) > 0) return loc
      }
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2))
      await page.waitForTimeout(800)
    }
    return undefined
  }

  private async resolveCalloutMint(page: Page, itemId: string): Promise<string | undefined> {
    const url = `https://frontend-api-v3.pump.fun/callout/${encodeURIComponent(itemId)}`
    const response = await page.request.get(url).catch(() => undefined)
    if (!response?.ok()) return undefined
    const body: unknown = await response.json().catch(() => undefined)
    return mintFromCalloutJson(body)
  }

  private async locateLikeCard(page: Page, itemId: string): Promise<Locator | undefined> {
    const onFeed = await this.findItemCard(page, itemId)
    if (onFeed) return onFeed
    const mint = await this.resolveCalloutMint(page, itemId)
    const permalink = mint ? pumpCalloutPermalink(mint, itemId) : undefined
    if (!permalink) return undefined
    await page.goto(permalink, {
      waitUntil: "domcontentloaded",
      timeout: this.opts.navigationTimeoutMs ?? 30_000,
    })
    this.detectChallenge(page)
    await this.dismissBlockingUi(page)
    return this.findItemCard(page, itemId)
  }

  private async likeOnCard(
    page: Page,
    itemId: string,
    card: Locator,
  ): Promise<{ verified: boolean, ambiguous: boolean }> {
    if (await this.controlLooksLiked(card, page, itemId)) {
      return { verified: true, ambiguous: false }
    }
    const posted = this.waitForPost(page, LIKE_POST_RE)
    const button = this.likeButton(card)
    await button.scrollIntoViewIfNeeded().catch(() => undefined)
    const clicked = await button
      .click({ timeout: 8_000 })
      .then(() => true)
      .catch(() => false)
    if (!clicked) return { verified: false, ambiguous: true }
    const response = await posted
    if (response?.ok()) return { verified: true, ambiguous: false }
    const present = await this.controlLooksLiked(card, page, itemId)
    return { verified: present, ambiguous: !present }
  }

  private likeRoot(card: Locator): Locator {
    return card.locator(`xpath=ancestor-or-self::*[.//*[@data-testid='${PUMP_LIKE_TEST_ID}']][1]`)
  }

  private likeButton(card: Locator): Locator {
    return this.likeRoot(card).locator(`[data-testid="${PUMP_LIKE_TEST_ID}"]`).first()
  }

  private async controlLooksLiked(card: Locator, page: Page, itemId: string): Promise<boolean> {
    const root = this.likeRoot(card)
    const unlike = await root.getByRole("button", { name: /unlike this callout/iu }).count()
      .catch(() => 0)
    if (unlike > 0) return true
    const pressed = await root.locator(`[data-testid="${PUMP_LIKE_TEST_ID}"][aria-pressed="true"]`).count()
      .catch(() => 0)
    if (pressed > 0) return true
    return page.locator(`[data-item-id="${itemId}"][data-liked="true"]`).count()
      .then((n) => n > 0)
      .catch(() => false)
  }

  private async cardLooksLiked(page: Page, itemId: string): Promise<boolean> {
    const card = await this.findItemCard(page, itemId)
    if (!card) {
      return page.locator(`[data-item-id="${itemId}"][data-liked="true"]`).count()
        .then((n) => n > 0)
        .catch(() => false)
    }
    return this.controlLooksLiked(card, page, itemId)
  }

  private async profileFollowState(page: Page): Promise<"following" | "not-following" | "unknown"> {
    const following = await page.getByRole("button", { name: /^(Following|Unfollow)$/u }).count()
      .catch(() => 0)
    if (following > 0) return "following"
    const follow = await page.getByRole("button", { name: /^Follow$/u }).count().catch(() => 0)
    if (follow > 0) return "not-following"
    return "unknown"
  }

  async like(itemId: string): Promise<{ verified: boolean, ambiguous: boolean }> {
    return this.withPage(async (page) => {
      const card = await this.locateLikeCard(page, itemId)
      if (!card) return { verified: false, ambiguous: true }
      return this.likeOnCard(page, itemId, card)
    })
  }

  async likeFirstVisible(): Promise<{ found: boolean, verified: boolean, ambiguous: boolean }> {
    return this.withPage(async (page) => {
      await page.locator("a[href*='/callouts/']").first().waitFor({ timeout: 15_000 }).catch(() => undefined)
      const href = await page.locator("a[href*='/callouts/']").first().getAttribute("href")
      const itemId = href?.match(CALLOUT_ID_RE)?.[0]
      if (!itemId) return { found: false, verified: false, ambiguous: true }
      const card = await this.locateLikeCard(page, itemId)
      if (!card) return { found: true, verified: false, ambiguous: true }
      const result = await this.likeOnCard(page, itemId, card)
      return { found: true, ...result }
    })
  }

  async follow(handle: string): Promise<{ verified: boolean, ambiguous: boolean }> {
    return this.withPage(async (page) => {
      await page.goto(`https://pump.fun/profile/${encodeURIComponent(handle)}`, {
        waitUntil: "domcontentloaded",
        timeout: this.opts.navigationTimeoutMs ?? 30_000,
      })
      this.detectChallenge(page)
      const posted = this.waitForPost(page, FOLLOW_POST_RE)
      const clicked = await page.getByRole("button", { name: /^Follow$/u }).first()
        .click({ timeout: 8_000 })
        .then(() => true)
        .catch(() => false)
      if (!clicked) return { verified: false, ambiguous: true }
      const response = await posted
      if (response?.ok()) return { verified: true, ambiguous: false }
      const state = await this.profileFollowState(page)
      if (state === "unknown") return { verified: false, ambiguous: true }
      return { verified: state === "following", ambiguous: state !== "following" }
    })
  }

  async unfollow(handle: string): Promise<{ verified: boolean, ambiguous: boolean }> {
    return this.withPage(async (page) => {
      await page.goto(`https://pump.fun/profile/${encodeURIComponent(handle)}`, {
        waitUntil: "domcontentloaded",
        timeout: this.opts.navigationTimeoutMs ?? 30_000,
      })
      this.detectChallenge(page)
      const posted = this.waitForPost(page, FOLLOW_POST_RE)
      const clicked = await page.getByRole("button", { name: /^(Following|Unfollow)$/u }).first()
        .click({ timeout: 8_000 })
        .then(() => true)
        .catch(() => false)
      if (!clicked) return { verified: false, ambiguous: true }
      const response = await posted
      if (response?.ok()) return { verified: true, ambiguous: false }
      const state = await this.profileFollowState(page)
      if (state === "unknown") return { verified: false, ambiguous: true }
      return { verified: state === "not-following", ambiguous: state !== "not-following" }
    })
  }

  async verifyLiked(itemId: string): Promise<boolean> {
    return this.withPage(async (page) => this.cardLooksLiked(page, itemId))
  }

  async verifyFollowing(handle: string): Promise<boolean> {
    return this.withPage(async (page) => {
      await page.goto(`https://pump.fun/profile/${encodeURIComponent(handle)}`, {
        waitUntil: "domcontentloaded",
        timeout: this.opts.navigationTimeoutMs ?? 30_000,
      })
      return (await this.profileFollowState(page)) === "following"
    })
  }
}
