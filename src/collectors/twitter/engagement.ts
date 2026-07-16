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

export async function installEngagementMutationGuard(context: BrowserContext): Promise<void> {
  await context.route("**/*", async (route: Route) => {
    const request = route.request()
    const method = request.method().toUpperCase()
    if (["GET", "HEAD", "OPTIONS"].includes(method)) {
      await route.continue()
      return
    }
    if (method === "POST") {
      const op = graphqlOperationName(request.url(), request.postData())
      if (isAllowedEngagementMutation(op)) {
        await route.continue()
        return
      }
      log.info("blocked non-engagement mutation", {
        method,
        op: op ?? "unknown",
        url: request.url().slice(0, 120),
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

function playwrightDriver(page: Page): EngagementDriver {
  return {
    like: async (postId) => {
      await page.goto(`https://x.com/i/web/status/${postId}`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await page.waitForTimeout(1_500)
      const like = page.locator('[data-testid="like"]').first()
      if (await like.count()) await like.click({ timeout: 10_000 })
      else {
        const unlike = page.locator('[data-testid="unlike"]').first()
        if (!(await unlike.count())) throw new Error(`like control missing for ${postId}`)
      }
      await page.waitForTimeout(1_000)
    },
    follow: async (handle) => {
      await page.goto(`https://x.com/${handle}`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await page.waitForTimeout(1_500)
      const follow = page.getByRole("button", { name: /^Follow @?/iu }).first()
        .or(page.locator('[data-testid*="follow"]').first())
      await follow.click({ timeout: 10_000 })
      await page.waitForTimeout(1_000)
    },
    unfollow: async (handle) => {
      await page.goto(`https://x.com/${handle}`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await page.waitForTimeout(1_500)
      const following = page.getByRole("button", { name: /Following|Unfollow/iu }).first()
      await following.click({ timeout: 10_000 })
      const confirm = page.getByRole("button", { name: /^Unfollow$/iu }).first()
      if (await confirm.count()) await confirm.click({ timeout: 5_000 })
      await page.waitForTimeout(1_000)
    },
    verifyLiked: async (postId) => {
      await page.goto(`https://x.com/i/web/status/${postId}`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await page.waitForTimeout(1_000)
      return (await page.locator('[data-testid="unlike"]').count()) > 0
    },
    verifyFollowing: async (handle) => {
      await page.goto(`https://x.com/${handle}`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await page.waitForTimeout(1_000)
      return (await page.getByRole("button", { name: /Following|Unfollow/iu }).count()) > 0
    },
  }
}
