import { chromium, type BrowserContext, type Page, type Route } from "playwright"
import { sha256Json } from "../../lib/canonical-json.js"
import { ensureTwitterProfileDir } from "../social/twitter-auth.js"
import { assertTwitterSessionReady } from "./scrape.js"
import { graphqlOperationName } from "./managed-list.js"
import type { XEngagementDecision, XEngagementReceipt } from "../../contracts/schemas.js"
import { log } from "../../lib/log.js"

/** Exact GraphQL ops allowed for host engagement executor (INV-R2). */
export const ALLOWED_ENGAGEMENT_MUTATIONS = [
  "FavoriteTweet",
  "UnfavoriteTweet",
  "CreateFriendships",
  "DestroyFriendships",
  // X sometimes uses these aliases
  "FriendshipCreate",
  "FriendshipDestroy",
] as const

/** Legacy REST friendship endpoints still used by some profile UIs */
export function isAllowedEngagementRestUrl(url: string): boolean {
  return /\/1\.1\/friendships\/(create|destroy)\.json(?:\?|$)/iu.test(url)
}

export const ENGAGEMENT_VERIFY_ATTEMPTS = 3
export const ENGAGEMENT_VERIFY_DELAY_MS = 500

export function isAllowedEngagementMutation(operationName: string | undefined): boolean {
  return operationName !== undefined
    && (ALLOWED_ENGAGEMENT_MUTATIONS as readonly string[]).includes(operationName)
}

export function isForbiddenEngagementMutation(operationName: string | undefined): boolean {
  if (!operationName) return true
  const blocked = [
    "CreateTweet",
    "CreateReply",
    "CreateRetweet",
    "DeleteRetweet",
    "CreateBookmark",
    "DeleteBookmark",
    "dmSendMessage",
    "SendMessage",
    "CreateList",
    "ListAddMember",
    "ListRemoveMember",
  ]
  return blocked.includes(operationName) || !isAllowedEngagementMutation(operationName)
}

export function isEngagementChallengeUrl(url: string): boolean {
  return /\/i\/flow\/login|\/account\/access|challenge/iu.test(url)
}

export async function installEngagementMutationGuard(context: BrowserContext): Promise<void> {
  await context.route("**/*", async (route: Route) => {
    const request = route.request()
    const method = request.method().toUpperCase()
    if (["GET", "HEAD", "OPTIONS"].includes(method)) {
      await route.continue()
      return
    }
    if (method === "POST") {
      const url = request.url()
      const op = graphqlOperationName(url, request.postData())
      if (isAllowedEngagementMutation(op) || isAllowedEngagementRestUrl(url)) {
        await route.continue()
        return
      }
      log.info("blocked non-engagement mutation", {
        method,
        op: op ?? "unknown",
        url: url.slice(0, 120),
      })
    }
    await route.abort("blockedbyclient")
  })
}

export type EngagementDriver = Readonly<{
  like: (postId: string) => Promise<void>
  follow: (handle: string) => Promise<void>
  unfollow: (handle: string) => Promise<void>
  verifyLiked?: (postId: string) => Promise<boolean>
  verifyFollowing?: (handle: string) => Promise<boolean>
}>

export type EngagementExecutionResult = Readonly<{
  receipts: readonly XEngagementReceipt[]
  verifiedActionIds: readonly `sha256:${string}`[]
  ambiguousActionIds: readonly `sha256:${string}`[]
}>

export function buildEngagementReceipt(args: Readonly<{
  actionId: `sha256:${string}`
  action: "like" | "follow" | "unfollow"
  target: string
  nowIso: string
  verified: boolean
  ambiguous: boolean
  error?: string
}>): XEngagementReceipt {
  return {
    schema: 1,
    receiptId: sha256Json({
      actionId: args.actionId,
      action: args.action,
      target: args.target,
      attemptedAt: args.nowIso,
      verified: args.verified,
    }),
    actionId: args.actionId,
    action: args.action,
    target: args.target,
    attemptedAt: args.nowIso,
    verified: args.verified,
    ambiguous: args.ambiguous,
    ...(args.error ? { error: args.error.slice(0, 500) } : {}),
  }
}

export async function executeEngagementActions(args: Readonly<{
  accepted: readonly XEngagementDecision[]
  nowIso: string
  headless?: boolean
  driver?: EngagementDriver
}>): Promise<EngagementExecutionResult> {
  if (args.accepted.length === 0) {
    return { receipts: [], verifiedActionIds: [], ambiguousActionIds: [] }
  }

  if (args.driver) {
    return executeWithDriver(args.accepted, args.nowIso, args.driver)
  }

  await ensureTwitterProfileDir()
  const state = assertTwitterSessionReady()
  const browser = await chromium.launch({ headless: args.headless !== false })
  try {
    const context = await browser.newContext({
      storageState: state,
      viewport: { width: 1280, height: 900 },
    })
    await installEngagementMutationGuard(context)
    const page = await context.newPage()
    const driver = playwrightDriver(page)
    const result = await executeWithDriver(args.accepted, args.nowIso, driver)
    await context.close()
    return result
  } finally {
    await browser.close()
  }
}

async function executeWithDriver(
  accepted: readonly XEngagementDecision[],
  nowIso: string,
  driver: EngagementDriver,
): Promise<EngagementExecutionResult> {
  const receipts: XEngagementReceipt[] = []
  const verifiedActionIds: `sha256:${string}`[] = []
  const ambiguousActionIds: `sha256:${string}`[] = []

  for (const decision of accepted) {
    if (!decision.accepted) continue
    const actionId = decision.actionId as `sha256:${string}`
    try {
      if (decision.action === "like") {
        await driver.like(decision.target)
      } else if (decision.action === "follow") {
        await driver.follow(decision.target)
      } else {
        await driver.unfollow(decision.target)
      }

      let verified = true
      if (decision.action === "like" && driver.verifyLiked) {
        verified = await driver.verifyLiked(decision.target)
      }
      if (decision.action === "follow" && driver.verifyFollowing) {
        verified = await driver.verifyFollowing(decision.target)
      }
      if (decision.action === "unfollow" && driver.verifyFollowing) {
        verified = !(await driver.verifyFollowing(decision.target))
      }

      const receipt = buildEngagementReceipt({
        actionId,
        action: decision.action,
        target: decision.target,
        nowIso,
        verified,
        ambiguous: !verified,
        ...(verified ? {} : { error: "post-action verification failed" }),
      })
      receipts.push(receipt)
      if (verified) verifiedActionIds.push(actionId)
      else ambiguousActionIds.push(actionId)
    } catch (error) {
      const receipt = buildEngagementReceipt({
        actionId,
        action: decision.action,
        target: decision.target,
        nowIso,
        verified: false,
        ambiguous: true,
        error: error instanceof Error ? error.message : String(error),
      })
      receipts.push(receipt)
      ambiguousActionIds.push(actionId)
    }
  }

  return { receipts, verifiedActionIds, ambiguousActionIds }
}

async function assertNotChallenged(page: Page): Promise<void> {
  if (isEngagementChallengeUrl(page.url())) {
    throw new Error("X login/challenge page detected — run `pnpm dev:cli auth twitter`")
  }
  const login = await page.locator('input[name="text"], input[autocomplete="username"]').count().catch(() => 0)
  const home = await page.locator('[data-testid="AppTabBar_Home_Link"]').count().catch(() => 0)
  if (login > 0 && home === 0) {
    throw new Error("X login/challenge page detected — run `pnpm dev:cli auth twitter`")
  }
}

async function waitForTweetShell(page: Page): Promise<void> {
  await page.locator('article[data-testid="tweet"]').first().waitFor({
    state: "visible",
    timeout: 20_000,
  })
}

async function waitForProfileShell(page: Page): Promise<void> {
  await page.locator('[data-testid="primaryColumn"]').first().waitFor({
    state: "visible",
    timeout: 20_000,
  })
}

export async function retryEngagementVerify(
  check: () => Promise<boolean>,
  attempts = ENGAGEMENT_VERIFY_ATTEMPTS,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check()) return true
    if (attempt + 1 < attempts) {
      await new Promise((resolve) => setTimeout(resolve, ENGAGEMENT_VERIFY_DELAY_MS))
    }
  }
  return false
}

function tweetLikeButton(page: Page) {
  return page.locator('article[data-testid="tweet"]').first().locator('[data-testid="like"]')
}

function tweetUnlikeButton(page: Page) {
  return page.locator('article[data-testid="tweet"]').first().locator('[data-testid="unlike"]')
}

function primaryColumn(page: Page) {
  return page.locator('[data-testid="primaryColumn"]')
}

function profileFollowButton(page: Page) {
  // X shows "Follow" or "Follow @handle"; avoid matching Following/Followers
  return primaryColumn(page).getByRole("button", { name: /^Follow(?!ing|ers)\b/iu }).first()
}

function profileFollowingButton(page: Page) {
  return primaryColumn(page).getByRole("button", { name: /^(Following|Unfollow)\b/iu }).first()
}

// Last resort for Follow only: X renders the control with a testid like `<id>-follow`
function profileFollowTestIdButton(page: Page) {
  return primaryColumn(page)
    .locator('[data-testid*="follow"]:not([data-testid*="unfollow"])')
    .first()
}

// Distinguish a genuinely unfollowable profile (subscribe-only, suspended,
// nonexistent) from a transient missing control, scoped to primaryColumn so we
// never match unrelated chrome.
async function assertFollowable(page: Page, handle: string): Promise<void> {
  const column = primaryColumn(page)
  const [subscribe, follow, following, unavailable] = await Promise.all([
    column.getByRole("button", { name: /^Subscribe\b/iu }).count().catch(() => 0),
    profileFollowButton(page).count().catch(() => 0),
    profileFollowingButton(page).count().catch(() => 0),
    column.getByText(/Account suspended|This account doesn.t exist|these posts are protected/iu)
      .count().catch(() => 0),
  ])
  if (unavailable > 0) throw new Error(`account_not_followable:${handle}`)
  if (subscribe > 0 && follow === 0 && following === 0) {
    throw new Error(`account_not_followable:${handle}`)
  }
}

// Bounded wait for the follow controls to hydrate; either state ending the wait
async function waitForFollowControls(page: Page): Promise<void> {
  await retryEngagementVerify(async () => (
    (await profileFollowButton(page).count()) > 0
    || (await profileFollowingButton(page).count()) > 0
  ))
}

function playwrightDriver(page: Page): EngagementDriver {
  return {
    like: async (postId) => {
      await page.goto(`https://x.com/i/web/status/${postId}`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await assertNotChallenged(page)
      await waitForTweetShell(page)
      if (await tweetUnlikeButton(page).count()) return
      const like = tweetLikeButton(page)
      if (!(await like.count())) {
        throw new Error(`like control missing for ${postId}`)
      }
      await like.click({ timeout: 10_000 })
    },
    follow: async (handle) => {
      await page.goto(`https://x.com/${handle}`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await assertNotChallenged(page)
      await waitForProfileShell(page)
      // desired state already satisfied
      if (await profileFollowingButton(page).count()) return
      await waitForFollowControls(page)
      if (await profileFollowingButton(page).count()) return
      const follow = profileFollowButton(page)
      if (await follow.count()) {
        await follow.click({ timeout: 10_000 })
        return
      }
      const fallback = profileFollowTestIdButton(page)
      if (await fallback.count()) {
        await fallback.click({ timeout: 10_000 })
        return
      }
      await assertFollowable(page, handle)
      throw new Error(`follow control missing for ${handle}`)
    },
    unfollow: async (handle) => {
      await page.goto(`https://x.com/${handle}`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await assertNotChallenged(page)
      await waitForProfileShell(page)
      await waitForFollowControls(page)
      // desired state already satisfied (Following control absent)
      if (!(await profileFollowingButton(page).count())) return
      await profileFollowingButton(page).click({ timeout: 10_000 })
      const confirm = page.getByRole("button", { name: /^Unfollow$/iu }).first()
      if (await confirm.count()) await confirm.click({ timeout: 5_000 })
    },
    verifyLiked: async (postId) => {
      await page.goto(`https://x.com/i/web/status/${postId}`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await assertNotChallenged(page)
      await waitForTweetShell(page)
      return retryEngagementVerify(async () => (await tweetUnlikeButton(page).count()) > 0)
    },
    verifyFollowing: async (handle) => {
      await page.goto(`https://x.com/${handle}`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await assertNotChallenged(page)
      await waitForProfileShell(page)
      return retryEngagementVerify(async () => (await profileFollowingButton(page).count()) > 0)
    },
  }
}
