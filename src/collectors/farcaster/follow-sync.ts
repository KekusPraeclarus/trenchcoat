import { gatedFetch, readJsonBody } from "../../lib/http.js"
import { sha256Json } from "../../lib/canonical-json.js"
import type { FetchLike } from "../market/geckoterminal.js"
import type { FcFollowSyncReceipt } from "../../contracts/schemas.js"
import { NEYNAR_HOST, NEYNAR_ROOT } from "./neynar.js"
import { followUser, unfollowUser } from "./engagement.js"
import { computeFollowDiff, confineFollowTargets } from "../../sources/fc-lifecycle.js"

const RATE = { capacity: 100, refillPerSecond: 100 / 60 } as const
const PAGE_LIMIT = 100

function arraysEqual(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function parseFollowingUsers(payload: unknown): number[] {
  if (payload === null || typeof payload !== "object") {
    throw new TypeError("Neynar following response invalid")
  }
  const users = Reflect.get(payload, "users")
  if (!Array.isArray(users)) throw new TypeError("Neynar following missing users")
  const fids: number[] = []
  for (const entry of users) {
    if (entry === null || typeof entry !== "object") continue
    const user = Reflect.get(entry, "user")
    const source = user !== null && typeof user === "object" ? user : entry
    const targetFid = Reflect.get(source, "fid")
    if (typeof targetFid === "number" && Number.isInteger(targetFid) && targetFid >= 1) {
      fids.push(targetFid)
    }
  }
  return fids
}

function nextCursor(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== "object") return undefined
  const next = Reflect.get(payload, "next")
  if (next === null || typeof next !== "object") return undefined
  const cursor = Reflect.get(next, "cursor")
  return typeof cursor === "string" ? cursor : undefined
}

export async function fetchFollowingFids(
  fetcher: FetchLike,
  apiKey: string,
  fid: number,
  opts: Readonly<{ limit?: number, all?: boolean }> = {},
): Promise<number[]> {
  if (!Number.isInteger(fid) || fid < 1) throw new TypeError("Invalid fid")
  const pageLimit = Math.min(Math.max(opts.limit ?? PAGE_LIMIT, 1), PAGE_LIMIT)
  const collected: number[] = []
  let cursor: string | undefined

  do {
    const url = new URL("/v2/farcaster/following", NEYNAR_ROOT)
    url.searchParams.set("fid", String(fid))
    url.searchParams.set("limit", String(pageLimit))
    if (cursor) url.searchParams.set("cursor", cursor)
    const response = await gatedFetch(fetcher, url, {
      host: NEYNAR_HOST,
      ...RATE,
      headers: { accept: "application/json", "x-api-key": apiKey },
    })
    if (!response.ok) throw new Error(`Neynar following HTTP ${response.status}`)
    const payload = await readJsonBody(response)
    collected.push(...parseFollowingUsers(payload))
    cursor = opts.all === false ? undefined : nextCursor(payload)
  } while (cursor)

  return [...new Set(collected)].sort((a, b) => a - b)
}

function isAlreadyFollowingError(message: string): boolean {
  return /already follow/i.test(message)
}

function isNotFollowingError(message: string): boolean {
  return /not follow/i.test(message) || /does not follow/i.test(message)
}

export async function syncFollowGraph(args: Readonly<{
  apiKey: string
  signerUuid: string
  botFid: number
  desiredFids: readonly number[]
  allowedFids: ReadonlySet<number>
  nowIso: string
  fetcher?: FetchLike
  dryRun?: boolean
}>): Promise<FcFollowSyncReceipt> {
  const fetcher = args.fetcher ?? fetch
  const currentlyFollowing = await fetchFollowingFids(fetcher, args.apiKey, args.botFid, { all: true })
  const managedCurrent = currentlyFollowing.filter((fid) => args.allowedFids.has(fid))
  const desired = confineFollowTargets(args.desiredFids, args.allowedFids)
  const diff = computeFollowDiff({
    desired,
    currentlyFollowing: managedCurrent,
  })
  const follow = confineFollowTargets(diff.follow, args.allowedFids)
  const unfollow = confineFollowTargets(diff.unfollow, args.allowedFids)

  const syncId = sha256Json({
    botFid: args.botFid,
    desired,
    attemptedAt: args.nowIso,
  })
  const desiredFidsHash = sha256Json(desired)

  if (args.dryRun) {
    return {
      schema: 1,
      syncId,
      botFid: args.botFid,
      attemptedAt: args.nowIso,
      desiredFidsHash,
      followed: follow,
      unfollowed: unfollow,
      verified: false,
      ambiguous: false,
      dryRun: true,
      desiredFids: desired,
      actualFids: managedCurrent,
      idempotentFollows: follow.filter((fid) => managedCurrent.includes(fid)),
      idempotentUnfollows: unfollow.filter((fid) => !managedCurrent.includes(fid)),
    }
  }

  const followingSet = new Set(managedCurrent)
  const followed: number[] = []
  const unfollowed: number[] = []
  const idempotentFollows: number[] = []
  const idempotentUnfollows: number[] = []
  const errors: string[] = []

  for (const targetFid of follow) {
    if (followingSet.has(targetFid)) {
      idempotentFollows.push(targetFid)
      followed.push(targetFid)
      continue
    }
    try {
      await followUser(fetcher, args.apiKey, args.signerUuid, targetFid)
      followed.push(targetFid)
      followingSet.add(targetFid)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (isAlreadyFollowingError(message)) {
        idempotentFollows.push(targetFid)
        followed.push(targetFid)
        followingSet.add(targetFid)
        continue
      }
      errors.push(message)
    }
  }

  for (const targetFid of unfollow) {
    if (!followingSet.has(targetFid)) {
      idempotentUnfollows.push(targetFid)
      unfollowed.push(targetFid)
      continue
    }
    try {
      await unfollowUser(fetcher, args.apiKey, args.signerUuid, targetFid)
      unfollowed.push(targetFid)
      followingSet.delete(targetFid)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (isNotFollowingError(message)) {
        idempotentUnfollows.push(targetFid)
        unfollowed.push(targetFid)
        followingSet.delete(targetFid)
        continue
      }
      errors.push(message)
    }
  }

  const refetchedAt = new Date().toISOString()
  const actualFollowing = await fetchFollowingFids(fetcher, args.apiKey, args.botFid, { all: true })
  const actualFids = actualFollowing.filter((targetFid) => args.allowedFids.has(targetFid))
  const verified = errors.length === 0 && arraysEqual(actualFids, desired)

  return {
    schema: 1,
    syncId,
    botFid: args.botFid,
    attemptedAt: args.nowIso,
    desiredFidsHash,
    followed,
    unfollowed,
    verified,
    ambiguous: !verified,
    dryRun: false,
    desiredFids: desired,
    actualFids,
    refetchedAt,
    idempotentFollows,
    idempotentUnfollows,
    ...(errors.length > 0 ? { error: errors.join("; ").slice(0, 500) } : {}),
    ...(!verified && errors.length === 0
      ? { error: `desired_actual_mismatch desired=${desired.join(",")} actual=${actualFids.join(",")}` }
      : {}),
  }
}
