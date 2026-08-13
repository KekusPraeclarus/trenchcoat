import { sha256Json } from "../lib/canonical-json.js"
import {
  PumpEngagementProposalFileSchema,
  PumpHandleSchema,
  PumpItemIdSchema,
  type PumpEngagementDecision,
  type PumpEngagementFile,
  type PumpEngagementProposalFile,
  type PumpEngagementProposalItem,
} from "../contracts/schemas.js"

export type PumpEngagementCaps = Readonly<{
  enabled: boolean
  likes_per_window: number
  like_window_minutes: number
  max_follows_per_run: number
}>

export type PumpEngagementApplyResult = Readonly<{
  decisions: readonly PumpEngagementDecision[]
  accepted: readonly PumpEngagementDecision[]
  rejected: readonly PumpEngagementDecision[]
  nextState: PumpEngagementFile
}>

export function parsePumpEngagementProposal(raw: unknown): PumpEngagementProposalFile {
  return PumpEngagementProposalFileSchema.parse(raw)
}

export function pumpEngagementActionId(
  item: PumpEngagementProposalItem,
  runId: string,
): `sha256:${string}` {
  if (item.action === "like") {
    return sha256Json({
      action: item.action,
      itemId: item.itemId,
      runId,
      reasonCode: item.reasonCode,
    })
  }
  return sha256Json({
    action: item.action,
    handle: item.handle.toLowerCase(),
    runId,
    reasonCode: item.reasonCode,
  })
}

function dayKey(iso: string): string {
  return iso.slice(0, 10)
}

function ensureDaily(file: PumpEngagementFile, nowIso: string): PumpEngagementFile {
  const day = dayKey(nowIso)
  if (file.daily.day === day) return file
  return {
    ...file,
    daily: { day, likes: 0, follows: 0, unfollows: 0 },
  }
}

function targetOf(item: PumpEngagementProposalItem): string {
  return item.action === "like" ? item.itemId : item.handle
}

export function currentFollowCount(file: PumpEngagementFile): number {
  return file.followedHandles.length
}

export function pumpLikesInWindow(
  file: PumpEngagementFile,
  nowIso: string,
  windowMinutes: number,
): number {
  const cutoff = Date.parse(nowIso) - windowMinutes * 60_000
  if (!Number.isFinite(cutoff)) return 0
  const fromReceipts = file.receipts.filter((receipt) => (
    receipt.action === "like"
    && Date.parse(receipt.attemptedAt) >= cutoff
  )).length
  const fromTimestamps = Object.values(file.lastLikedAt)
    .filter((iso) => Date.parse(iso) >= cutoff)
    .length
  return Math.max(fromReceipts, fromTimestamps)
}

function normalizePumpHandle(raw: string): string | undefined {
  const trimmed = raw.trim()
  const parsed = PumpHandleSchema.safeParse(trimmed)
  return parsed.success ? parsed.data : undefined
}

/**
 * Apply agent like/follow/unfollow. Likes bind to same-run pump-fyp-eligible
 * item ids. Follow/unfollow bind to authors in that snapshot (INV-S29).
 */
export function applyPumpEngagementChoices(args: Readonly<{
  proposal: PumpEngagementProposalFile
  state: PumpEngagementFile
  caps: PumpEngagementCaps
  nowIso: string
  eligibleItemIds?: ReadonlySet<string> | readonly string[]
  eligibleAuthors?: ReadonlySet<string> | readonly string[]
}>): PumpEngagementApplyResult {
  let state = ensureDaily(args.state, args.nowIso)
  if (!args.caps.enabled) {
    return { decisions: [], accepted: [], rejected: [], nextState: state }
  }

  const eligibleIds = args.eligibleItemIds instanceof Set
    ? args.eligibleItemIds
    : new Set(args.eligibleItemIds ?? [])
  const eligibleAuthors = new Set(
    [...(args.eligibleAuthors ?? [])]
      .map((h) => normalizePumpHandle(h))
      .filter((h): h is string => h !== undefined),
  )

  const knownActionIds = new Set([
    ...state.decisions.map((d) => d.actionId),
    ...state.receipts.map((r) => r.actionId),
  ])
  const likedIds = new Set(state.likedItemIds)
  const followed = new Set(state.followedHandles)
  const pendingSet = new Set(state.pendingActionIds)
  const pendingTargets = new Set(
    state.decisions
      .filter((d) => d.accepted && pendingSet.has(d.actionId))
      .map((d) => `${d.action}\u0000${d.target}`),
  )

  let likesInWin = pumpLikesInWindow(state, args.nowIso, args.caps.like_window_minutes)
  let likesDay = state.daily.likes
  let followsDay = state.daily.follows
  let unfollowsDay = state.daily.unfollows
  let followsThisRun = 0

  const decisions: PumpEngagementDecision[] = []
  const accepted: PumpEngagementDecision[] = []
  const rejected: PumpEngagementDecision[] = []
  const pending = [...state.pendingActionIds]

  for (const item of args.proposal.items) {
    const actionId = pumpEngagementActionId(item, args.proposal.runId)
    const base = {
      schema: 1 as const,
      actionId,
      action: item.action,
      target: targetOf(item),
      reasonCode: item.reasonCode,
      runId: args.proposal.runId,
      decidedAt: args.nowIso,
    }

    const reject = (reason: string): void => {
      const decision: PumpEngagementDecision = {
        ...base,
        accepted: false,
        rejectReason: reason,
      }
      decisions.push(decision)
      rejected.push(decision)
    }

    if (knownActionIds.has(actionId)) {
      reject("duplicate_action_id")
      continue
    }
    knownActionIds.add(actionId)

    if (item.action === "like") {
      if (!PumpItemIdSchema.safeParse(item.itemId).success) {
        reject("invalid_item_id")
        continue
      }
      if (!eligibleIds.has(item.itemId)) {
        reject("item_id_not_in_eligible")
        continue
      }
      if (likedIds.has(item.itemId)) {
        reject("already_liked")
        continue
      }
      if (pendingTargets.has(`like\u0000${item.itemId}`)) {
        reject("pending_duplicate")
        continue
      }
      if (likesInWin >= args.caps.likes_per_window) {
        reject("like_rate_limit")
        continue
      }
      likesInWin += 1
      likesDay += 1
    } else if (item.action === "follow") {
      const handle = normalizePumpHandle(item.handle)
      if (!handle) {
        reject("invalid_handle")
        continue
      }
      if (!eligibleAuthors.has(handle)) {
        reject("handle_not_in_eligible")
        continue
      }
      if (followed.has(handle)) {
        reject("already_following")
        continue
      }
      if (pendingTargets.has(`follow\u0000${handle}`)) {
        reject("pending_duplicate")
        continue
      }
      if (followsThisRun >= args.caps.max_follows_per_run) {
        reject("follow_rate_limit")
        continue
      }
      followsThisRun += 1
      followsDay += 1
    } else {
      const handle = normalizePumpHandle(item.handle)
      if (!handle) {
        reject("invalid_handle")
        continue
      }
      if (!eligibleAuthors.has(handle)) {
        reject("handle_not_in_eligible")
        continue
      }
      if (!followed.has(handle)) {
        reject("not_following")
        continue
      }
      if (pendingTargets.has(`unfollow\u0000${handle}`)) {
        reject("pending_duplicate")
        continue
      }
      unfollowsDay += 1
    }

    const decision: PumpEngagementDecision = { ...base, accepted: true }
    decisions.push(decision)
    accepted.push(decision)
    pending.push(actionId)
  }

  return {
    decisions,
    accepted,
    rejected,
    nextState: {
      ...state,
      pendingActionIds: pending,
      decisions: [...state.decisions, ...decisions].slice(-100_000),
      daily: {
        day: dayKey(args.nowIso),
        likes: likesDay,
        follows: followsDay,
        unfollows: unfollowsDay,
      },
    },
  }
}
