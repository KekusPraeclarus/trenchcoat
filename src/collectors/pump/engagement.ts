import { type Browser, type BrowserContext, type Page } from "playwright"
import { launchChromium } from "../../lib/playwright-chromium.js"
import { assertPumpProfileReady, pumpProfileDir } from "../social/pump-auth.js"
import { classifyPumpRequest } from "./request-policy.js"
import { PumpClientError } from "./types.js"

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
      return await run(page)
    } finally {
      await page.close().catch(() => undefined)
    }
  }

  async like(itemId: string): Promise<{ verified: boolean, ambiguous: boolean }> {
    return this.withPage(async (page) => {
      const clicked = await page.locator(`[data-item-id="${itemId}"], [data-coin-id="${itemId}"]`).first()
        .locator("button, [role=button]").first()
        .click({ timeout: 8_000 })
        .then(() => true)
        .catch(() => false)
      if (!clicked) return { verified: false, ambiguous: true }
      const present = await this.verifyLiked(itemId)
      return { verified: present, ambiguous: !present }
    })
  }

  async follow(handle: string): Promise<{ verified: boolean, ambiguous: boolean }> {
    return this.withPage(async (page) => {
      await page.goto(`https://pump.fun/profile/${encodeURIComponent(handle)}`, {
        waitUntil: "domcontentloaded",
        timeout: this.opts.navigationTimeoutMs ?? 30_000,
      })
      this.detectChallenge(page)
      const clicked = await page.getByRole("button", { name: /follow/iu }).first()
        .click({ timeout: 8_000 })
        .then(() => true)
        .catch(() => false)
      if (!clicked) return { verified: false, ambiguous: true }
      const present = await this.verifyFollowing(handle)
      return { verified: present, ambiguous: !present }
    })
  }

  async unfollow(handle: string): Promise<{ verified: boolean, ambiguous: boolean }> {
    return this.withPage(async (page) => {
      await page.goto(`https://pump.fun/profile/${encodeURIComponent(handle)}`, {
        waitUntil: "domcontentloaded",
        timeout: this.opts.navigationTimeoutMs ?? 30_000,
      })
      this.detectChallenge(page)
      const clicked = await page.getByRole("button", { name: /unfollow|following/iu }).first()
        .click({ timeout: 8_000 })
        .then(() => true)
        .catch(() => false)
      if (!clicked) return { verified: false, ambiguous: true }
      const present = await this.verifyFollowing(handle)
      return { verified: !present, ambiguous: present }
    })
  }

  async verifyLiked(itemId: string): Promise<boolean> {
    return this.withPage(async (page) => {
      const liked = page.locator(`[data-item-id="${itemId}"][data-liked="true"]`)
      return liked.count().then((n) => n > 0).catch(() => false)
    })
  }

  async verifyFollowing(handle: string): Promise<boolean> {
    return this.withPage(async (page) => {
      await page.goto(`https://pump.fun/profile/${encodeURIComponent(handle)}`, {
        waitUntil: "domcontentloaded",
        timeout: this.opts.navigationTimeoutMs ?? 30_000,
      })
      const unfollowed = await page.getByRole("button", { name: /^follow$/iu }).count()
      return unfollowed === 0
    })
  }
}
