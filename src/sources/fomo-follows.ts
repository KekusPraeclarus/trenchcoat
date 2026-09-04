import type { FomoFollowsFile, FomoFollowReceipt } from "../contracts/schemas.js"
import type { FomoLeaderboardEntry } from "../collectors/fomo/types.js"

export type FomoFollowFn = (args: Readonly<{
  handle: string
  headless?: boolean
}>) => Promise<Readonly<{
  verified: boolean
  ambiguous: boolean
  error?: string
}>>

export const FOMO_FOLLOW_COOLDOWN_MS = 24 * 60 * 60 * 1000

export function emptyFomoFollows(): FomoFollowsFile {
  return {
    schema: 1,
    followedHandles: [],
    lastFollowedAt: {},
    receipts: [],
  }
}

export function coolingFomoHandles(args: Readonly<{
  receipts: readonly FomoFollowReceipt[]
  nowIso: string
  cooldownMs?: number
}>): ReadonlySet<string> {
  const cooldown = args.cooldownMs ?? FOMO_FOLLOW_COOLDOWN_MS
  const now = Date.parse(args.nowIso)
  const latest = new Map<string, FomoFollowReceipt>()
  for (const receipt of args.receipts) {
    const key = receipt.handle.toLowerCase()
    const prev = latest.get(key)
    if (!prev || receipt.attemptedAt > prev.attemptedAt) latest.set(key, receipt)
  }
  const out = new Set<string>()
  if (!Number.isFinite(now)) return out
  for (const [handle, receipt] of latest) {
    if (receipt.verified) continue
    const at = Date.parse(receipt.attemptedAt)
    if (Number.isFinite(at) && now - at < cooldown) out.add(handle)
  }
  return out
}

export function planFomoFollows(args: Readonly<{
  traders: readonly FomoLeaderboardEntry[]
  followedHandles: readonly string[]
  maxFollowing: number
  maxFollowsPerRun: number
  receipts?: readonly FomoFollowReceipt[]
  nowIso?: string
  cooldownMs?: number
}>): readonly string[] {
  const have = new Set(args.followedHandles.map((h) => h.toLowerCase()))
  const cooling = args.nowIso
    ? coolingFomoHandles({
      receipts: args.receipts ?? [],
      nowIso: args.nowIso,
      ...(args.cooldownMs !== undefined ? { cooldownMs: args.cooldownMs } : {}),
    })
    : new Set<string>()
  const room = Math.max(0, args.maxFollowing - have.size)
  const cap = Math.min(args.maxFollowsPerRun, room)
  const out: string[] = []
  for (const trader of args.traders) {
    const handle = trader.handle.trim().replace(/^@/u, "").toLowerCase()
    if (!handle || have.has(handle) || cooling.has(handle) || out.includes(handle)) continue
    out.push(handle)
    if (out.length >= cap) break
  }
  return out
}

export async function applyFomoFollows(args: Readonly<{
  file: FomoFollowsFile
  traders: readonly FomoLeaderboardEntry[]
  nowIso: string
  maxFollowing: number
  maxFollowsPerRun: number
  follow?: FomoFollowFn
}>): Promise<Readonly<{
  file: FomoFollowsFile
  attempted: number
  verified: number
}>> {
  const toFollow = planFomoFollows({
    traders: args.traders,
    followedHandles: args.file.followedHandles,
    maxFollowing: args.maxFollowing,
    maxFollowsPerRun: args.maxFollowsPerRun,
    receipts: args.file.receipts,
    nowIso: args.nowIso,
  })
  if (toFollow.length === 0) {
    return { file: args.file, attempted: 0, verified: 0 }
  }
  const follow = args.follow ?? (await import("../collectors/fomo/engagement.js")).followFomoHandle
  const followed = new Set(args.file.followedHandles.map((h) => h.toLowerCase()))
  const lastFollowedAt = { ...args.file.lastFollowedAt }
  const receipts: FomoFollowReceipt[] = [...args.file.receipts]
  let verified = 0
  for (const handle of toFollow) {
    const result = await follow({ handle })
    const receipt: FomoFollowReceipt = {
      schema: 1,
      handle,
      attemptedAt: args.nowIso,
      verified: result.verified,
      ambiguous: result.ambiguous,
      ...(result.error ? { error: result.error.slice(0, 500) } : {}),
    }
    receipts.push(receipt)
    if (result.verified) {
      followed.add(handle)
      lastFollowedAt[handle] = args.nowIso
      verified += 1
    }
  }
  return {
    file: {
      schema: 1,
      followedHandles: [...followed].sort((a, b) => a.localeCompare(b)),
      lastFollowedAt,
      receipts: receipts.slice(-20_000),
    },
    attempted: toFollow.length,
    verified,
  }
}
