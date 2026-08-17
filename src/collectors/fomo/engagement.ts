import { type Page } from "playwright"
import { launchChromium } from "../../lib/playwright-chromium.js"
import { assertFomoProfileReady, fomoProfileDir } from "../social/fomo-auth.js"
import { classifyFomoRequest } from "./request-policy.js"
import { FomoClientError } from "./types.js"

const FOLLOW_TIMEOUT_MS = 20_000

export type FomoFollowAttempt = Readonly<{
  verified: boolean
  ambiguous: boolean
  error?: string
}>

async function detectChallenge(page: Page): Promise<boolean> {
  const url = page.url()
  if (/challenge|cloudflare|cdn-cgi\/challenge/iu.test(url)) return true
  const body = await page.evaluate(() => document.body?.innerText?.slice(0, 400) ?? "")
  return /sign in|log in|login/iu.test(body)
    && !/leaderboard|feed|trending|prices|alerts|watchlist|follow/iu.test(body)
}

export async function verifyFomoFollowing(page: Page): Promise<boolean> {
  const following = await page.getByRole("button", { name: /following|unfollow/iu }).count()
  return following > 0
}

/**
 * Host-only FOMO profile follow. Request policy allows follow/unfollow
 * mutations only in this path. Never writes wallets.
 */
export async function followFomoHandle(args: Readonly<{
  handle: string
  headless?: boolean
}>): Promise<FomoFollowAttempt> {
  const handle = args.handle.trim().replace(/^@/u, "")
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(handle)) {
    return { verified: false, ambiguous: true, error: "invalid-handle" }
  }
  const storageState = assertFomoProfileReady(fomoProfileDir())
  const browser = await launchChromium({
    headless: args.headless !== false,
    args: ["--disable-blink-features=AutomationControlled"],
  })
  try {
    const context = await browser.newContext({
      storageState,
      viewport: { width: 1440, height: 900 },
    })
    await context.route("**/*", async (route) => {
      const request = route.request()
      const decision = classifyFomoRequest(request.method(), request.url(), {
        mutationMode: true,
      })
      if (!decision.allow) {
        await route.abort("blockedbyclient")
        return
      }
      await route.continue()
    })
    const page = await context.newPage()
    await page.goto(`https://fomo.family/profile/${encodeURIComponent(handle)}`, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    })
    if (await detectChallenge(page)) {
      throw new FomoClientError("challenged", "Fomo challenge during follow")
    }
    if (await verifyFomoFollowing(page)) {
      await context.close()
      return { verified: true, ambiguous: false }
    }
    const followBtn = page.getByRole("button", { name: /^follow$/iu }).first()
    await followBtn.click({ timeout: FOLLOW_TIMEOUT_MS })
    await page.waitForTimeout(1_500)
    const verified = await verifyFomoFollowing(page)
    await context.close()
    return {
      verified,
      ambiguous: !verified,
      ...(verified ? {} : { error: "follow-unverified" }),
    }
  } catch (error) {
    return {
      verified: false,
      ambiguous: true,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await browser.close().catch(() => undefined)
  }
}
