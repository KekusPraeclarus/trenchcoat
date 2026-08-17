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

export function emptyFomoFollows(): FomoFollowsFile {
  return {
    schema: 1,
    followedHandles: [],
    lastFollowedAt: {},
    receipts: [],
  }
}

export function planFomoFollows(args: Readonly<{
  traders: readonly FomoLeaderboardEntry[]
  followedHandles: readonly string[]
  maxFollowing: number
  maxFollowsPerRun: number
}>): readonly string[] {
  const have = new Set(args.followedHandles.map((h) => h.toLowerCase()))
  const room = Math.max(0, args.maxFollowing - have.size)
  const cap = Math.min(args.maxFollowsPerRun, room)
  const out: string[] = []
  for (const trader of args.traders) {
    const handle = trader.handle.trim().replace(/^@/u, "").toLowerCase()
    if (!handle || have.has(handle) || out.includes(handle)) continue
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
