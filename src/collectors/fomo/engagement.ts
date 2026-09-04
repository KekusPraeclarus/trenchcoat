import { type Page } from "playwright"
import { launchChromium } from "../../lib/playwright-chromium.js"
import { assertFomoProfileReady, fomoProfileDir } from "../social/fomo-auth.js"
import { extractProfileUser } from "./mappers.js"
import {
  classifyFomoRequest,
  FOMO_BOOT_PATH,
  isFomoFollowMutationPath,
  isFomoProfileUserHandleUrl,
} from "./request-policy.js"
import { FomoClientError } from "./types.js"

const FOLLOW_TIMEOUT_MS = 20_000
const BOOT_TIMEOUT_MS = 30_000
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

export const FOMO_FOLLOW_NAME = /^follow$/iu
export const FOMO_FOLLOWING_NAME = /^(following|unfollow)$/iu

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

async function hideMobileBlocker(page: Page): Promise<void> {
  await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll(".mobile-blocker"))
    for (const el of nodes) {
      el.setAttribute("style", "display:none")
    }
  })
}

function extractUserId(payload: unknown): string | undefined {
  const user = extractProfileUser(payload)
  if (!user || typeof user !== "object") return undefined
  const id = Reflect.get(user, "id")
  return typeof id === "string" && id.length > 0 ? id : undefined
}

export function extractFollowingIds(payload: unknown): readonly string[] {
  if (!payload || typeof payload !== "object") return []
  const nested = Reflect.get(payload, "responseObject")
  const raw = nested && typeof nested === "object"
    ? Reflect.get(nested, "followingIds")
    : undefined
  if (!Array.isArray(raw)) return []
  return raw.filter((id): id is string => typeof id === "string" && id.length > 0)
}

export function isFomoFollowingIdsUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.hostname === "prod-api.fomo.family"
      && parsed.pathname === "/v2/users/current/followingIds"
  } catch {
    return false
  }
}

export async function verifyFomoFollowing(page: Page): Promise<boolean> {
  const following = await page.getByRole("button", { name: FOMO_FOLLOWING_NAME }).count()
  return following > 0
}

function isFollowMutationRequest(url: string, method: string): boolean {
  const verb = method.toUpperCase()
  if (verb === "GET" || verb === "HEAD" || verb === "OPTIONS") return false
  try {
    return isFomoFollowMutationPath(new URL(url).pathname)
  } catch {
    return false
  }
}

/**
 * Host-only FOMO profile follow. Request policy allows follow/unfollow
 * mutations only in this path. Never writes wallets.
 * Direct /profile stays on the React Router spinner until the token boot
 * route loads the SPA.
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
  const blockedMutations: string[] = []
  try {
    const context = await browser.newContext({
      storageState,
      viewport: { width: 1440, height: 900 },
      userAgent: USER_AGENT,
    })
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined })
    })
    await context.route("**/*", async (route) => {
      const request = route.request()
      const decision = classifyFomoRequest(request.method(), request.url(), {
        mutationMode: true,
        allowedPosts: [
          { host: "featureassets.org", path: "/v1/initialize" },
        ],
      })
      if (!decision.allow) {
        const verb = request.method().toUpperCase()
        if (
          verb !== "GET"
          && verb !== "HEAD"
          && verb !== "OPTIONS"
          && /prod-api\.fomo\.family/iu.test(request.url())
        ) {
          blockedMutations.push(`${verb} ${request.url().slice(0, 180)}`)
        }
        await route.abort("blockedbyclient")
        return
      }
      await route.continue()
    })
    const page = await context.newPage()
    await page.goto(`https://fomo.family${FOMO_BOOT_PATH}`, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    })
    if (await detectChallenge(page)) {
      throw new FomoClientError("challenged", "Fomo challenge during follow boot")
    }
    await page.getByRole("button", { name: /leaderboard/iu }).first().waitFor({
      timeout: BOOT_TIMEOUT_MS,
    })
    const profileWait = page.waitForResponse(
      (response) => isFomoProfileUserHandleUrl(response.url(), handle),
      { timeout: FOLLOW_TIMEOUT_MS },
    ).catch(() => undefined)
    const idsBefore = page.waitForResponse(
      (response) => isFomoFollowingIdsUrl(response.url()),
      { timeout: FOLLOW_TIMEOUT_MS },
    ).catch(() => undefined)
    await page.goto(`https://fomo.family/profile/${encodeURIComponent(handle)}`, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    })
    const profileResponse = await profileWait
    const idsBeforeResponse = await idsBefore
    const userId = profileResponse
      ? extractUserId(await profileResponse.json().catch(() => undefined))
      : undefined
    let followingIds = idsBeforeResponse
      ? [...extractFollowingIds(await idsBeforeResponse.json().catch(() => undefined))]
      : []
    if (await detectChallenge(page)) {
      throw new FomoClientError("challenged", "Fomo challenge during follow")
    }
    await hideMobileBlocker(page)
    const followBtn = page.getByRole("button", { name: FOMO_FOLLOW_NAME }).first()
    const followingBtn = page.getByRole("button", { name: FOMO_FOLLOWING_NAME }).first()
    await followBtn.or(followingBtn).waitFor({ timeout: FOLLOW_TIMEOUT_MS })
    if ((userId && followingIds.includes(userId)) || await verifyFomoFollowing(page)) {
      await context.close()
      return { verified: true, ambiguous: false }
    }
    const mutationWait = page.waitForRequest(
      (request) => isFollowMutationRequest(request.url(), request.method()),
      { timeout: FOLLOW_TIMEOUT_MS },
    ).catch(() => undefined)
    const idsWait = page.waitForResponse(
      (response) => isFomoFollowingIdsUrl(response.url()),
      { timeout: FOLLOW_TIMEOUT_MS },
    ).catch(() => undefined)
    await followBtn.click({ timeout: FOLLOW_TIMEOUT_MS })
    const [, idsAfter] = await Promise.all([mutationWait, idsWait])
    if (idsAfter) {
      followingIds = [...extractFollowingIds(await idsAfter.json().catch(() => undefined))]
    }
    await page.waitForTimeout(1_500)
    const verified = (userId ? followingIds.includes(userId) : false)
      || await verifyFomoFollowing(page)
    await context.close()
    if (verified) {
      return { verified: true, ambiguous: false }
    }
    const blocked = blockedMutations[0]
    return {
      verified: false,
      ambiguous: true,
      error: blocked ? `follow-blocked:${blocked}` : "follow-unverified",
    }
  } catch (error) {
    const blocked = blockedMutations[0]
    const base = error instanceof Error ? error.message : String(error)
    return {
      verified: false,
      ambiguous: true,
      error: blocked ? `${base.slice(0, 200)} follow-blocked:${blocked}` : base,
    }
  } finally {
    await browser.close().catch(() => undefined)
  }
}
