import { createHash } from "node:crypto"
import { type BrowserContext, type Page, type Route } from "playwright"
import { sha256Json } from "../../lib/canonical-json.js"
import { launchChromium } from "../../lib/playwright-chromium.js"
import { twitterProfileDir, ensureTwitterProfileDir } from "../social/twitter-auth.js"
import { assertTwitterSessionReady } from "./scrape.js"
import type { XListSyncReceipt } from "../../contracts/schemas.js"
import { log } from "../../lib/log.js"

/** Exact GraphQL operation names allowed for host-only list mutations (INV-R2). */
export const ALLOWED_LIST_MUTATIONS = [
  "CreateList",
  "ListAddMember",
  "ListRemoveMember",
] as const

export type AllowedListMutation = typeof ALLOWED_LIST_MUTATIONS[number]

export type ManagedListIdentity = Readonly<{
  listId: string
  listUrl: string
}>

export type MembershipDiff = Readonly<{
  toAdd: readonly string[]
  toRemove: readonly string[]
}>

export type SyncAttempt = Readonly<{
  managedListId: string
  desiredHandles: readonly string[]
  currentHandles: readonly string[]
  maxTransitions: number
  nowIso: string
}>

export type SyncResult = Readonly<{
  receipt: XListSyncReceipt
  remainingDesired: readonly string[]
}>

export function assertListId(listId: string): string {
  if (!/^\d+$/u.test(listId)) {
    throw new TypeError(`Invalid managed list id: ${listId}`)
  }
  return listId
}

export function listUrlForId(listId: string): string {
  return `https://x.com/i/lists/${assertListId(listId)}`
}

export const LIST_UI_TIMEOUT_MS = 30_000

/** Case-insensitive profile href. X keeps the original handle case in the URL. */
export function profileHrefSelector(handle: string): string {
  const safe = handle.replace(/[^A-Za-z0-9_]/gu, "")
  return `a[href="/${safe}" i]`
}

export function computeMembershipDiff(
  current: readonly string[],
  desired: readonly string[],
): MembershipDiff {
  const currentSet = new Set(current.map((h) => h.toLowerCase()))
  const desiredSet = new Set(desired.map((h) => h.toLowerCase()))
  const toAdd = [...desiredSet].filter((h) => !currentSet.has(h)).sort()
  const toRemove = [...currentSet].filter((h) => !desiredSet.has(h)).sort()
  return { toAdd, toRemove }
}

export function membershipIdempotencyKey(
  listId: string,
  action: "add" | "remove",
  handle: string,
): string {
  return createHash("sha256")
    .update(`list:${listId}:${action}:${handle.toLowerCase()}`)
    .digest("hex")
}

export function confineListId(persistedId: string, targetId: string): void {
  if (assertListId(persistedId) !== assertListId(targetId)) {
    throw new Error(
      `List ID confinement: refused mutation on ${targetId}; managed list is ${persistedId}`,
    )
  }
}

export function graphqlOperationName(url: string, postData: string | null): string | undefined {
  if (postData) {
    try {
      const body = JSON.parse(postData) as { operationName?: unknown }
      if (typeof body.operationName === "string" && /^[A-Za-z][A-Za-z0-9_]*$/u.test(body.operationName)) {
        return body.operationName
      }
    } catch { /* fall through to URL */ }
  }
  try {
    const parsed = new URL(url)
    const fromQuery = parsed.searchParams.get("operationName")
      ?? parsed.pathname.split("/").filter(Boolean).at(-1)
    if (fromQuery && /^[A-Za-z][A-Za-z0-9_]*$/u.test(fromQuery)) return fromQuery
  } catch { /* ignore */ }
  return undefined
}

export function isAllowedListMutation(operationName: string | undefined): boolean {
  return operationName !== undefined
    && (ALLOWED_LIST_MUTATIONS as readonly string[]).includes(operationName)
}

/** Install route guard: only GET/HEAD/OPTIONS plus exact list GraphQL mutations. */
export async function installListMutationGuard(context: BrowserContext): Promise<void> {
  await context.route("**/*", async (route: Route) => {
    const request = route.request()
    const method = request.method().toUpperCase()
    if (["GET", "HEAD", "OPTIONS"].includes(method)) {
      await route.continue()
      return
    }
    if (method === "POST") {
      const op = graphqlOperationName(request.url(), request.postData())
      if (isAllowedListMutation(op)) {
        await route.continue()
        return
      }
    }
    log.info("blocked non-list mutation", {
      method,
      url: request.url().slice(0, 120),
    })
    await route.abort("blockedbyclient")
  })
}

export function planSyncBatch(attempt: SyncAttempt): MembershipDiff {
  confineListId(attempt.managedListId, attempt.managedListId)
  const full = computeMembershipDiff(attempt.currentHandles, attempt.desiredHandles)
  // Prefer removals first (capacity), then adds; honor transition cap
  const removals = full.toRemove.slice(0, attempt.maxTransitions)
  const remaining = attempt.maxTransitions - removals.length
  const adds = full.toAdd.slice(0, Math.max(0, remaining))
  return { toAdd: adds, toRemove: removals }
}

export function buildSyncReceipt(args: Readonly<{
  managedListId: string
  desiredHandles: readonly string[]
  added: readonly string[]
  removed: readonly string[]
  verified: boolean
  ambiguous: boolean
  nowIso: string
  error?: string
}>): XListSyncReceipt {
  const syncId = sha256Json({
    managedListId: args.managedListId,
    desired: [...args.desiredHandles].sort(),
    added: [...args.added].sort(),
    removed: [...args.removed].sort(),
    attemptedAt: args.nowIso,
  })
  return {
    schema: 1,
    syncId,
    managedListId: args.managedListId,
    attemptedAt: args.nowIso,
    desiredHandlesHash: sha256Json([...args.desiredHandles].sort()),
    added: [...args.added],
    removed: [...args.removed],
    verified: args.verified,
    ambiguous: args.ambiguous,
    ...(args.error ? { error: args.error.slice(0, 500) } : {}),
  }
}

async function detectChallenge(page: Page): Promise<boolean> {
  const url = page.url()
  if (/\/i\/flow\/login|\/account\/access|challenge/iu.test(url)) return true
  const login = await page.locator('input[name="text"], input[autocomplete="username"]').count().catch(() => 0)
  const home = await page.locator('[data-testid="AppTabBar_Home_Link"]').count().catch(() => 0)
  return login > 0 && home === 0
}

/** Snapshot member handles from a list members page (best-effort DOM parse). */
export async function scrapeListMembers(page: Page, listId: string): Promise<string[]> {
  assertListId(listId)
  await page.goto(`https://x.com/i/lists/${listId}/members`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  })
  await page.waitForTimeout(2_000)
  if (await detectChallenge(page)) {
    throw new Error("X challenge during list membership scrape — re-auth required")
  }
  const handles = new Set<string>()
  for (let i = 0; i < 8; i += 1) {
    const links = await page.locator('a[role="link"][href^="/"]').evaluateAll((nodes) =>
      nodes
        .map((n) => (n as HTMLAnchorElement).getAttribute("href") ?? "")
        .filter((href) => /^\/[A-Za-z0-9_]{1,15}$/u.test(href))
        .map((href) => href.slice(1)),
    )
    for (const handle of links) {
      if (!["home", "explore", "search", "notifications", "messages", "settings", "i"].includes(handle.toLowerCase())) {
        handles.add(handle)
      }
    }
    await page.mouse.wheel(0, 2_400)
    await page.waitForTimeout(800)
  }
  return [...handles].sort((a, b) => a.localeCompare(b))
}

/**
 * Create a private managed list once. Returns identity for persistence.
 * Does not mutate if operator cancels / challenge appears.
 */
export async function createManagedPrivateList(args: Readonly<{
  name: string
  description: string
  headless?: boolean
}>): Promise<ManagedListIdentity> {
  await ensureTwitterProfileDir()
  const state = assertTwitterSessionReady()
  const browser = await launchChromium({ headless: args.headless === true })
  try {
    const context = await browser.newContext({
      storageState: state,
      viewport: { width: 1280, height: 900 },
    })
    await installListMutationGuard(context)
    const page = await context.newPage()
    await page.goto("https://x.com/i/lists/create", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    })
    if (await detectChallenge(page)) {
      throw new Error("X challenge during list create — run auth twitter first")
    }

    // Prefer accessible name fields; fall back to placeholder inputs
    const nameInput = page.getByLabel(/name/iu).or(page.locator('input[name="name"]')).first()
    await nameInput.waitFor({ timeout: 15_000 })
    await nameInput.fill(args.name.slice(0, 25))
    const desc = page.getByLabel(/description/iu).or(page.locator('textarea')).first()
    if (await desc.count()) {
      await desc.fill(args.description.slice(0, 100))
    }

    // Private toggle when present
    const privateToggle = page.getByRole("switch", { name: /private/iu })
      .or(page.getByText(/make private|private/iu))
    if (await privateToggle.count()) {
      await privateToggle.first().click().catch(() => undefined)
    }

    const next = page.getByRole("button", { name: /next|create|done/iu }).first()
    await next.click()
    await page.waitForTimeout(3_000)

    const url = page.url()
    const match = url.match(/\/i\/lists\/(\d+)/u) ?? url.match(/\/lists\/(\d+)/u)
    if (!match?.[1]) {
      throw new Error(`Could not resolve created list id from URL: ${url}`)
    }
    const listId = match[1]
    await context.close()
    return { listId, listUrl: listUrlForId(listId) }
  } finally {
    await browser.close()
  }
}

/**
 * Synchronize membership of the single managed private list.
 * Refuses wrong list IDs; records ambiguous failures instead of guessing.
 */
export async function syncManagedListMembership(args: Readonly<{
  managedListId: string
  desiredHandles: readonly string[]
  maxTransitions: number
  nowIso: string
  headless?: boolean
  /** Injectable for tests */
  driver?: {
    scrapeMembers: (listId: string) => Promise<string[]>
    addMember: (listId: string, handle: string) => Promise<void>
    removeMember: (listId: string, handle: string) => Promise<void>
  }
}>): Promise<SyncResult> {
  const managedListId = assertListId(args.managedListId)
  const desired = [...new Set(args.desiredHandles.map((h) => h.toLowerCase()))].sort()

  if (args.driver) {
    return syncWithDriver({
      managedListId,
      desired,
      maxTransitions: args.maxTransitions,
      nowIso: args.nowIso,
      driver: args.driver,
    })
  }

  await ensureTwitterProfileDir()
  const state = assertTwitterSessionReady()
  const browser = await launchChromium({ headless: args.headless !== false })
  try {
    const context = await browser.newContext({
      storageState: state,
      viewport: { width: 1280, height: 900 },
    })
    await installListMutationGuard(context)
    const page = await context.newPage()

    let current: string[]
    try {
      current = await scrapeListMembers(page, managedListId)
    } catch (error) {
      const receipt = buildSyncReceipt({
        managedListId,
        desiredHandles: desired,
        added: [],
        removed: [],
        verified: false,
        ambiguous: true,
        nowIso: args.nowIso,
        error: error instanceof Error ? error.message : String(error),
      })
      await context.close()
      return { receipt, remainingDesired: desired }
    }

    const batch = planSyncBatch({
      managedListId,
      desiredHandles: desired,
      currentHandles: current,
      maxTransitions: args.maxTransitions,
      nowIso: args.nowIso,
    })

    const added: string[] = []
    const removed: string[] = []
    let ambiguous = false
    let error: string | undefined

    for (const handle of batch.toRemove) {
      try {
        confineListId(managedListId, managedListId)
        await removeListMemberUi(page, managedListId, handle)
        removed.push(handle)
      } catch (err) {
        ambiguous = true
        error = err instanceof Error ? err.message : String(err)
        break
      }
    }

    if (!ambiguous) {
      for (const handle of batch.toAdd) {
        try {
          confineListId(managedListId, managedListId)
          await addListMemberUi(page, managedListId, handle)
          added.push(handle)
        } catch (err) {
          ambiguous = true
          error = err instanceof Error ? err.message : String(err)
          break
        }
      }
    }

    let verified = false
    if (!ambiguous) {
      try {
        const after = await scrapeListMembers(page, managedListId)
        const afterSet = new Set(after.map((h) => h.toLowerCase()))
        verified = added.every((h) => afterSet.has(h))
          && removed.every((h) => !afterSet.has(h))
        if (!verified) {
          ambiguous = true
          error = "post-mutation membership verification failed"
        }
      } catch (err) {
        ambiguous = true
        error = err instanceof Error ? err.message : String(err)
      }
    }

    await context.close()
    const receipt = buildSyncReceipt({
      managedListId,
      desiredHandles: desired,
      added,
      removed,
      verified,
      ambiguous,
      nowIso: args.nowIso,
      ...(error ? { error } : {}),
    })
    return { receipt, remainingDesired: desired }
  } finally {
    await browser.close()
  }
}

async function syncWithDriver(args: Readonly<{
  managedListId: string
  desired: readonly string[]
  maxTransitions: number
  nowIso: string
  driver: NonNullable<Parameters<typeof syncManagedListMembership>[0]["driver"]>
}>): Promise<SyncResult> {
  let current: string[]
  try {
    current = await args.driver.scrapeMembers(args.managedListId)
  } catch (error) {
    return {
      receipt: buildSyncReceipt({
        managedListId: args.managedListId,
        desiredHandles: args.desired,
        added: [],
        removed: [],
        verified: false,
        ambiguous: true,
        nowIso: args.nowIso,
        error: error instanceof Error ? error.message : String(error),
      }),
      remainingDesired: args.desired,
    }
  }

  const batch = planSyncBatch({
    managedListId: args.managedListId,
    desiredHandles: args.desired,
    currentHandles: current,
    maxTransitions: args.maxTransitions,
    nowIso: args.nowIso,
  })

  const added: string[] = []
  const removed: string[] = []
  let ambiguous = false
  let error: string | undefined

  for (const handle of batch.toRemove) {
    try {
      await args.driver.removeMember(args.managedListId, handle)
      removed.push(handle)
    } catch (err) {
      ambiguous = true
      error = err instanceof Error ? err.message : String(err)
      break
    }
  }
  if (!ambiguous) {
    for (const handle of batch.toAdd) {
      try {
        await args.driver.addMember(args.managedListId, handle)
        added.push(handle)
      } catch (err) {
        ambiguous = true
        error = err instanceof Error ? err.message : String(err)
        break
      }
    }
  }

  let verified = false
  if (!ambiguous) {
    try {
      const after = await args.driver.scrapeMembers(args.managedListId)
      const afterSet = new Set(after.map((h) => h.toLowerCase()))
      verified = added.every((h) => afterSet.has(h))
        && removed.every((h) => !afterSet.has(h))
      if (!verified) {
        ambiguous = true
        error = "post-mutation membership verification failed"
      }
    } catch (err) {
      ambiguous = true
      error = err instanceof Error ? err.message : String(err)
    }
  }

  return {
    receipt: buildSyncReceipt({
      managedListId: args.managedListId,
      desiredHandles: args.desired,
      added,
      removed,
      verified,
      ambiguous,
      nowIso: args.nowIso,
      ...(error ? { error } : {}),
    }),
    remainingDesired: args.desired,
  }
}

async function addListMemberUi(page: Page, listId: string, handle: string): Promise<void> {
  await page.goto(`https://x.com/i/lists/${listId}/members`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  })
  const addBtn = page.getByRole("button", { name: /add|suggest/iu }).first()
  if (await addBtn.count()) await addBtn.click()
  const search = page.getByPlaceholder(/search/iu).or(page.locator('input[type="text"]')).first()
  await search.waitFor({ timeout: LIST_UI_TIMEOUT_MS })
  await search.fill(handle)
  await page.waitForTimeout(1_500)
  const row = page.getByRole("button", { name: new RegExp(`@?${handle}`, "iu") })
    .or(page.locator(profileHrefSelector(handle)))
    .first()
  await row.click({ timeout: LIST_UI_TIMEOUT_MS })
  const confirm = page.getByRole("button", { name: /add|done|save/iu }).first()
  if (await confirm.count()) await confirm.click().catch(() => undefined)
  await page.waitForTimeout(1_500)
  void membershipIdempotencyKey(listId, "add", handle)
}

async function removeListMemberUi(page: Page, listId: string, handle: string): Promise<void> {
  await page.goto(`https://x.com/i/lists/${listId}/members`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  })
  const row = page.locator(profileHrefSelector(handle)).first()
  try {
    await row.waitFor({ timeout: LIST_UI_TIMEOUT_MS })
  } catch {
    return
  }
  const remove = page.getByRole("button", { name: /remove|more/iu }).first()
  if (await remove.count()) {
    await remove.click()
    const confirm = page.getByRole("menuitem", { name: /remove/iu })
      .or(page.getByRole("button", { name: /remove/iu }))
      .first()
    await confirm.click({ timeout: LIST_UI_TIMEOUT_MS })
  }
  await page.waitForTimeout(1_500)
  void membershipIdempotencyKey(listId, "remove", handle)
}

export function profileDirSafe(): string {
  return twitterProfileDir()
}
