import { chromium, type BrowserContext, type Page, type Route } from "playwright"
import { sha256Json } from "../../lib/canonical-json.js"
import { ensureTwitterProfileDir } from "../social/twitter-auth.js"
import { assertTwitterSessionReady } from "./scrape.js"
import { graphqlOperationName } from "./managed-list.js"
import type {
  XEngagementDecision,
  XEngagementOutcome,
  XEngagementReceipt,
} from "../../contracts/schemas.js"
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
export const ENGAGEMENT_MUTATION_RESPONSE_TIMEOUT_MS = 15_000
export const ENGAGEMENT_CLICK_TIMEOUT_MS = 10_000

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

/** Digits-only post ids only — used in CSS :has() selectors */
export function assertEngagementPostId(postId: string): string {
  if (!/^\d{5,25}$/u.test(postId)) {
    throw new TypeError(`invalid engagement post id: ${postId.slice(0, 32)}`)
  }
  return postId
}

/** Scope like controls to the article that owns this status id (not quotes/recs). */
export function tweetArticleCssForPostId(postId: string): string {
  const id = assertEngagementPostId(postId)
  return `article[data-testid="tweet"]:has(a[href*="/status/${id}"])`
}

export function isFavoriteTweetResponse(url: string, postData: string | null): boolean {
  return graphqlOperationName(url, postData) === "FavoriteTweet"
}

export type EngagementAttemptStage = "already-satisfied" | "attempted" | "failed-before-mutation"

export type EngagementAttemptResult = Readonly<{
  stage: EngagementAttemptStage
  attemptError?: string
  mutationObserved?: boolean
}>

export type EngagementDriver = Readonly<{
  like: (postId: string) => Promise<void | EngagementAttemptResult>
  follow: (handle: string) => Promise<void | EngagementAttemptResult>
  unfollow: (handle: string) => Promise<void | EngagementAttemptResult>
  verifyLiked?: (postId: string) => Promise<boolean>
  verifyFollowing?: (handle: string) => Promise<boolean>
}>

export type EngagementExecutionResult = Readonly<{
  receipts: readonly XEngagementReceipt[]
  verifiedActionIds: readonly `sha256:${string}`[]
  ambiguousActionIds: readonly `sha256:${string}`[]
  failedActionIds: readonly `sha256:${string}`[]
}>

export function normalizeEngagementAttempt(
  result: void | EngagementAttemptResult,
): EngagementAttemptResult {
  if (result && typeof result === "object" && "stage" in result) return result
  return { stage: "attempted" }
}

export function settleEngagementOutcome(args: Readonly<{
  attempt: EngagementAttemptResult
  desiredState: boolean | undefined
}>): Readonly<{
  outcome: XEngagementOutcome
  verified: boolean
  ambiguous: boolean
  verificationError?: string
}> {
  if (args.attempt.stage === "already-satisfied") {
    return { outcome: "already-satisfied", verified: true, ambiguous: false }
  }
  if (args.attempt.stage === "failed-before-mutation") {
    return {
      outcome: "failed-before-mutation",
      verified: false,
      ambiguous: false,
      ...(args.attempt.attemptError
        ? { verificationError: args.attempt.attemptError.slice(0, 500) }
        : {}),
    }
  }
  // Never invent success when the verifier was absent
  if (args.desiredState === undefined) {
    return {
      outcome: "ambiguous",
      verified: false,
      ambiguous: true,
      verificationError: "verifier-absent",
    }
  }
  if (args.desiredState) {
    if (args.attempt.attemptError) {
      return {
        outcome: "verified-after-attempt-error",
        verified: true,
        ambiguous: false,
      }
    }
    return { outcome: "verified", verified: true, ambiguous: false }
  }
  return {
    outcome: "ambiguous",
    verified: false,
    ambiguous: true,
    verificationError: "post-action verification failed",
  }
}

export function buildEngagementReceipt(args: Readonly<{
  actionId: `sha256:${string}`
  action: "like" | "follow" | "unfollow"
  target: string
  nowIso: string
  outcome: XEngagementOutcome
  verified: boolean
  ambiguous: boolean
  attemptError?: string
  verificationError?: string
  error?: string
}>): XEngagementReceipt {
  const legacyError = args.error
    ?? args.attemptError
    ?? args.verificationError
  return {
    schema: 1,
    receiptId: sha256Json({
      actionId: args.actionId,
      action: args.action,
      target: args.target,
      attemptedAt: args.nowIso,
      verified: args.verified,
      outcome: args.outcome,
    }),
    actionId: args.actionId,
    action: args.action,
    target: args.target,
    attemptedAt: args.nowIso,
    verified: args.verified,
    ambiguous: args.ambiguous,
    outcome: args.outcome,
    ...(args.attemptError ? { attemptError: args.attemptError.slice(0, 500) } : {}),
    ...(args.verificationError
      ? { verificationError: args.verificationError.slice(0, 500) }
      : {}),
    ...(legacyError ? { error: legacyError.slice(0, 500) } : {}),
  }
}

export type PlaywrightEngagementSession = Readonly<{
  driver: EngagementDriver
  close: () => Promise<void>
}>

/** Shared Playwright session for reconcile (read-only) and mutation execution. */
export async function openPlaywrightEngagementSession(args: Readonly<{
  headless?: boolean
}> = {}): Promise<PlaywrightEngagementSession> {
  await ensureTwitterProfileDir()
  const state = assertTwitterSessionReady()
  const browser = await chromium.launch({ headless: args.headless !== false })
  const context = await browser.newContext({
    storageState: state,
    viewport: { width: 1280, height: 900 },
  })
  await installEngagementMutationGuard(context)
  const page = await context.newPage()
  const driver = playwrightDriver(page)
  return {
    driver,
    close: async () => {
      await context.close()
      await browser.close()
    },
  }
}

export async function executeEngagementActions(args: Readonly<{
  accepted: readonly XEngagementDecision[]
  nowIso: string
  headless?: boolean
  driver?: EngagementDriver
}>): Promise<EngagementExecutionResult> {
  if (args.accepted.length === 0) {
    return {
      receipts: [],
      verifiedActionIds: [],
      ambiguousActionIds: [],
      failedActionIds: [],
    }
  }

  if (args.driver) {
    return executeWithDriver(args.accepted, args.nowIso, args.driver)
  }

  const session = await openPlaywrightEngagementSession({
    ...(args.headless === undefined ? {} : { headless: args.headless }),
  })
  try {
    return await executeWithDriver(args.accepted, args.nowIso, session.driver)
  } finally {
    await session.close()
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
  const failedActionIds: `sha256:${string}`[] = []

  for (const decision of accepted) {
    if (!decision.accepted) continue
    const actionId = decision.actionId as `sha256:${string}`
    try {
      let rawAttempt: void | EngagementAttemptResult
      if (decision.action === "like") {
        rawAttempt = await driver.like(decision.target)
      } else if (decision.action === "follow") {
        rawAttempt = await driver.follow(decision.target)
      } else {
        rawAttempt = await driver.unfollow(decision.target)
      }
      const attempt = normalizeEngagementAttempt(rawAttempt)

      let desiredState: boolean | undefined
      if (attempt.stage === "already-satisfied") {
        desiredState = true
      } else if (attempt.stage === "failed-before-mutation") {
        desiredState = false
      } else if (decision.action === "like") {
        desiredState = driver.verifyLiked
          ? await driver.verifyLiked(decision.target)
          : undefined
      } else if (decision.action === "follow") {
        desiredState = driver.verifyFollowing
          ? await driver.verifyFollowing(decision.target)
          : undefined
      } else if (driver.verifyFollowing) {
        desiredState = !(await driver.verifyFollowing(decision.target))
      } else {
        desiredState = undefined
      }

      const settled = settleEngagementOutcome({ attempt, desiredState })
      const receipt = buildEngagementReceipt({
        actionId,
        action: decision.action,
        target: decision.target,
        nowIso,
        outcome: settled.outcome,
        verified: settled.verified,
        ambiguous: settled.ambiguous,
        ...(attempt.attemptError ? { attemptError: attempt.attemptError } : {}),
        ...(settled.verificationError
          ? { verificationError: settled.verificationError }
          : {}),
      })
      receipts.push(receipt)
      if (settled.verified) verifiedActionIds.push(actionId)
      else if (settled.ambiguous) ambiguousActionIds.push(actionId)
      else failedActionIds.push(actionId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const receipt = buildEngagementReceipt({
        actionId,
        action: decision.action,
        target: decision.target,
        nowIso,
        outcome: "ambiguous",
        verified: false,
        ambiguous: true,
        attemptError: message,
        error: message,
      })
      receipts.push(receipt)
      ambiguousActionIds.push(actionId)
    }
  }

  return { receipts, verifiedActionIds, ambiguousActionIds, failedActionIds }
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

function tweetArticle(page: Page, postId: string) {
  return page.locator(tweetArticleCssForPostId(postId)).first()
}

function tweetLikeButton(page: Page, postId: string) {
  return tweetArticle(page, postId).locator('[data-testid="like"]')
}

function tweetUnlikeButton(page: Page, postId: string) {
  return tweetArticle(page, postId).locator('[data-testid="unlike"]')
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

async function observeFavoriteTweetResponse(page: Page): Promise<boolean> {
  try {
    await page.waitForResponse(
      (response) => {
        if (response.request().method().toUpperCase() !== "POST") return false
        if (!response.ok()) return false
        return isFavoriteTweetResponse(
          response.url(),
          response.request().postData(),
        )
      },
      { timeout: ENGAGEMENT_MUTATION_RESPONSE_TIMEOUT_MS },
    )
    return true
  } catch {
    return false
  }
}

function playwrightDriver(page: Page): EngagementDriver {
  return {
    like: async (postId) => {
      await page.goto(`https://x.com/i/web/status/${assertEngagementPostId(postId)}`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await assertNotChallenged(page)
      await waitForTweetShell(page)
      const article = tweetArticle(page, postId)
      if (!(await article.count())) {
        return {
          stage: "failed-before-mutation",
          attemptError: `target article missing for ${postId}`,
        }
      }
      if (await tweetUnlikeButton(page, postId).count()) {
        return { stage: "already-satisfied" }
      }
      const like = tweetLikeButton(page, postId)
      if (!(await like.count())) {
        return {
          stage: "failed-before-mutation",
          attemptError: `like control missing for ${postId}`,
        }
      }

      // Click timeout must not end settlement — FavoriteTweet + UI verify still count
      const mutationObservedP = observeFavoriteTweetResponse(page)
      let attemptError: string | undefined
      try {
        await like.click({ timeout: ENGAGEMENT_CLICK_TIMEOUT_MS })
      } catch (error) {
        attemptError = error instanceof Error ? error.message : String(error)
      }
      const mutationObserved = await mutationObservedP
      return {
        stage: "attempted",
        mutationObserved,
        ...(attemptError ? { attemptError } : {}),
      }
    },
    follow: async (handle) => {
      await page.goto(`https://x.com/${handle}`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await assertNotChallenged(page)
      await waitForProfileShell(page)
      if (await profileFollowingButton(page).count()) {
        return { stage: "already-satisfied" }
      }
      await waitForFollowControls(page)
      if (await profileFollowingButton(page).count()) {
        return { stage: "already-satisfied" }
      }
      const follow = profileFollowButton(page)
      if (await follow.count()) {
        try {
          await follow.click({ timeout: ENGAGEMENT_CLICK_TIMEOUT_MS })
          return { stage: "attempted" }
        } catch (error) {
          return {
            stage: "attempted",
            attemptError: error instanceof Error ? error.message : String(error),
          }
        }
      }
      const fallback = profileFollowTestIdButton(page)
      if (await fallback.count()) {
        try {
          await fallback.click({ timeout: ENGAGEMENT_CLICK_TIMEOUT_MS })
          return { stage: "attempted" }
        } catch (error) {
          return {
            stage: "attempted",
            attemptError: error instanceof Error ? error.message : String(error),
          }
        }
      }
      try {
        await assertFollowable(page, handle)
      } catch (error) {
        return {
          stage: "failed-before-mutation",
          attemptError: error instanceof Error ? error.message : String(error),
        }
      }
      return {
        stage: "failed-before-mutation",
        attemptError: `follow control missing for ${handle}`,
      }
    },
    unfollow: async (handle) => {
      await page.goto(`https://x.com/${handle}`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await assertNotChallenged(page)
      await waitForProfileShell(page)
      await waitForFollowControls(page)
      if (!(await profileFollowingButton(page).count())) {
        return { stage: "already-satisfied" }
      }
      try {
        await profileFollowingButton(page).click({ timeout: ENGAGEMENT_CLICK_TIMEOUT_MS })
        const confirm = page.getByRole("button", { name: /^Unfollow$/iu }).first()
        if (await confirm.count()) await confirm.click({ timeout: 5_000 })
        return { stage: "attempted" }
      } catch (error) {
        return {
          stage: "attempted",
          attemptError: error instanceof Error ? error.message : String(error),
        }
      }
    },
    verifyLiked: async (postId) => {
      await page.goto(`https://x.com/i/web/status/${assertEngagementPostId(postId)}`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
      await assertNotChallenged(page)
      await waitForTweetShell(page)
      return retryEngagementVerify(async () => (await tweetUnlikeButton(page, postId).count()) > 0)
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
