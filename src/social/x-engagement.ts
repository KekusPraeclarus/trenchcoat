import { sha256Json } from "../lib/canonical-json.js"
import { normalizeHandle } from "../sources/lifecycle.js"
import type {
  XEngagementDecision,
  XEngagementFile,
  XEngagementProposalFile,
  XEngagementProposalItem,
} from "../contracts/schemas.js"
import {
  XEngagementProposalFileSchema,
} from "../contracts/schemas.js"

export const DEFAULT_FOLLOW_AFTER_LIKES = 25
export const FOLLOW_THRESHOLD_REASON = "like_threshold"

export type EngagementCaps = Readonly<{
  enabled: boolean
  likes_per_window: number
  like_window_minutes: number
  follow_after_likes?: number
}>

export type EngagementApplyResult = Readonly<{
  decisions: readonly XEngagementDecision[]
  accepted: readonly XEngagementDecision[]
  rejected: readonly XEngagementDecision[]
  nextState: XEngagementFile
}>

export function parseEngagementProposal(raw: unknown): XEngagementProposalFile {
  return XEngagementProposalFileSchema.parse(raw)
}

export function engagementActionId(
  item: XEngagementProposalItem,
  runId: string,
): `sha256:${string}` {
  if (item.action === "like") {
    return sha256Json({
      action: item.action,
      postId: item.postId,
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

function ensureDaily(file: XEngagementFile, nowIso: string): XEngagementFile {
  const day = dayKey(nowIso)
  if (file.daily.day === day) return file
  return {
    ...file,
    daily: { day, likes: 0, follows: 0, unfollows: 0 },
  }
}

function targetOf(item: XEngagementProposalItem): string {
  return item.action === "like" ? item.postId : item.handle.toLowerCase()
}

/** Count likes already attempted inside the sliding window (receipts + timestamps). */
export function likesInWindow(
  file: XEngagementFile,
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

/** Normalize a handle for FYP membership comparison, undefined when invalid. */
function normalizedFypHandle(raw: string): string | undefined {
  return normalizeHandle(raw)?.toLowerCase()
}

function likesByAuthor(likedPostAuthors: Readonly<Record<string, string>>): Map<string, number> {
  const counts = new Map<string, number>()
  for (const author of Object.values(likedPostAuthors)) {
    const handle = author.toLowerCase()
    counts.set(handle, (counts.get(handle) ?? 0) + 1)
  }
  return counts
}

function clearFollowedFromDue(
  followed: ReadonlySet<string>,
  due: readonly string[],
): string[] {
  return [...new Set(
    due
      .map((handle) => handle.toLowerCase())
      .filter((handle) => !followed.has(handle)),
  )].sort()
}

export function followDueHandlesAfter(
  followed: Iterable<string>,
  due: readonly string[] | undefined,
): string[] {
  const set = new Set([...followed].map((handle) => handle.toLowerCase()))
  return clearFollowedFromDue(set, due ?? [])
}

/**
 * Apply bot engagement choices. Bot owns the decisions; the only throttle is
 * likes_per_window within like_window_minutes (default 2 / 10m).
 * Host also follows an FYP author after follow_after_likes unique liked posts
 * (default 25). Likes must target post ids collected from the same-run FYP
 * snapshot, and follow/unfollow must target authors seen in that same snapshot
 * (INV-S22). Subscription-state dedupe rejects choices already reflected in
 * persisted state (liked posts, followed handles) or still pending execution, so a
 * replayed proposal never re-attempts a settled action. Schema + idempotency
 * keys remain for crash safety.
 */
export function applyEngagementChoices(args: Readonly<{
  proposal: XEngagementProposalFile
  state: XEngagementFile
  caps: EngagementCaps
  nowIso: string
  fypPostIds?: ReadonlySet<string> | readonly string[]
  fypAuthors?: ReadonlySet<string> | readonly string[]
}>): EngagementApplyResult {
  let state = ensureDaily(args.state, args.nowIso)
  if (!args.caps.enabled) {
    return {
      decisions: [],
      accepted: [],
      rejected: [],
      nextState: state,
    }
  }

  const fypIds = args.fypPostIds instanceof Set
    ? args.fypPostIds
    : new Set(args.fypPostIds ?? [])

  const fypAuthorSet = new Set(
    [...(args.fypAuthors ?? [])]
      .map(normalizedFypHandle)
      .filter((h): h is string => h !== undefined),
  )

  const knownActionIds = new Set([
    ...state.decisions.map((d) => d.actionId),
    ...state.receipts.map((r) => r.actionId),
  ])

  // Subscription state: what the account already reflects, independent of runId
  const likedPostIds = new Set([
    ...state.likedPostIds,
    ...state.receipts
      .filter((r) => r.action === "like" && r.verified)
      .map((r) => r.target),
  ])
  const followedHandles = new Set(
    state.followedHandles.map((h) => h.toLowerCase()),
  )

  // Accepted-but-unexecuted actions, keyed by action+target for cross-run dedupe
  const pendingSet = new Set(state.pendingActionIds)
  const pendingTargets = new Set(
    state.decisions
      .filter((d) => d.accepted && pendingSet.has(d.actionId))
      .map((d) => `${d.action}\u0000${d.target}`),
  )

  let likesInWin = likesInWindow(
    state,
    args.nowIso,
    args.caps.like_window_minutes,
  )
  let likesDay = state.daily.likes
  let followsDay = state.daily.follows
  let unfollowsDay = state.daily.unfollows

  const decisions: XEngagementDecision[] = []
  const accepted: XEngagementDecision[] = []
  const rejected: XEngagementDecision[] = []
  const pending = [...state.pendingActionIds]
  const likedPostAuthors: Record<string, string> = { ...(state.likedPostAuthors ?? {}) }

  for (const item of args.proposal.items) {
    const actionId = engagementActionId(item, args.proposal.runId)
    const base = {
      schema: 1 as const,
      actionId,
      action: item.action,
      target: targetOf(item),
      reasonCode: item.reasonCode,
      topics: item.topics,
      runId: args.proposal.runId,
      decidedAt: args.nowIso,
    }

    const reject = (reason: string): void => {
      const decision: XEngagementDecision = {
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
      if (!/^\d{5,25}$/u.test(item.postId)) {
        reject("invalid_post_id")
        continue
      }
      if (!fypIds.has(item.postId)) {
        reject("post_id_not_in_fyp")
        continue
      }
      if (likedPostIds.has(item.postId)) {
        reject("already_liked")
        continue
      }
      if (pendingTargets.has(`like\u0000${item.postId}`)) {
        reject("pending_duplicate")
        continue
      }
      if (likesInWin >= args.caps.likes_per_window) {
        reject("like_rate_limit")
        continue
      }
      likesInWin += 1
      likesDay += 1
      const author = normalizedFypHandle(item.authorHandle)
      if (author) likedPostAuthors[item.postId] = author
    } else if (item.action === "follow") {
      const handle = normalizeHandle(item.handle)
      if (!handle) {
        reject("invalid_handle")
        continue
      }
      if (!fypAuthorSet.has(handle.toLowerCase())) {
        reject("handle_not_in_fyp")
        continue
      }
      if (followedHandles.has(handle.toLowerCase())) {
        reject("already_following")
        continue
      }
      if (pendingTargets.has(`follow\u0000${handle.toLowerCase()}`)) {
        reject("pending_duplicate")
        continue
      }
      followsDay += 1
    } else {
      const handle = normalizeHandle(item.handle)
      if (!handle) {
        reject("invalid_handle")
        continue
      }
      if (!fypAuthorSet.has(handle.toLowerCase())) {
        reject("handle_not_in_fyp")
        continue
      }
      if (!followedHandles.has(handle.toLowerCase())) {
        reject("not_following")
        continue
      }
      if (pendingTargets.has(`unfollow\u0000${handle.toLowerCase()}`)) {
        reject("pending_duplicate")
        continue
      }
      unfollowsDay += 1
    }

    const decision: XEngagementDecision = { ...base, accepted: true }
    decisions.push(decision)
    accepted.push(decision)
    pending.push(actionId)
    if (item.action === "follow") {
      pendingTargets.add(`follow\u0000${normalizeHandle(item.handle)!.toLowerCase()}`)
    }
  }

  const threshold = args.caps.follow_after_likes ?? DEFAULT_FOLLOW_AFTER_LIKES
  const followDue = new Set(
    clearFollowedFromDue(followedHandles, state.followDueHandles ?? []),
  )
  if (threshold > 0) {
    const counts = likesByAuthor(likedPostAuthors)
    for (const [handle, count] of counts) {
      if (count >= threshold && !followedHandles.has(handle)) followDue.add(handle)
    }
    for (const handle of [...followDue]) {
      if (followedHandles.has(handle)) {
        followDue.delete(handle)
        continue
      }
      if (pendingTargets.has(`follow\u0000${handle}`)) continue
      if (!fypAuthorSet.has(handle)) continue

      const item: XEngagementProposalItem = {
        action: "follow",
        handle,
        reasonCode: FOLLOW_THRESHOLD_REASON,
        topics: [],
        rationale: "host follow after liked-post threshold",
      }
      const actionId = engagementActionId(item, args.proposal.runId)
      if (knownActionIds.has(actionId)) continue
      knownActionIds.add(actionId)
      const decision: XEngagementDecision = {
        schema: 1,
        actionId,
        action: "follow",
        target: handle,
        reasonCode: FOLLOW_THRESHOLD_REASON,
        topics: [],
        accepted: true,
        runId: args.proposal.runId,
        decidedAt: args.nowIso,
      }
      decisions.push(decision)
      accepted.push(decision)
      pending.push(actionId)
      pendingTargets.add(`follow\u0000${handle}`)
      followsDay += 1
    }
  }

  return {
    decisions,
    accepted,
    rejected,
    nextState: {
      ...state,
      likedPostAuthors,
      followDueHandles: [...followDue].sort(),
      pendingActionIds: [...new Set(pending)],
      decisions: [...state.decisions, ...decisions],
      daily: {
        day: dayKey(args.nowIso),
        likes: likesDay,
        follows: followsDay,
        unfollows: unfollowsDay,
      },
    },
  }
}

/** @deprecated use applyEngagementChoices */
export function validateEngagementProposals(args: Readonly<{
  proposal: XEngagementProposalFile
  state: XEngagementFile
  caps: EngagementCaps
  fypPosts?: readonly { id: string, author: string }[]
  nowIso: string
}>): EngagementApplyResult {
  return applyEngagementChoices({
    proposal: args.proposal,
    state: args.state,
    caps: args.caps,
    nowIso: args.nowIso,
    fypPostIds: (args.fypPosts ?? []).map((p) => p.id),
    fypAuthors: (args.fypPosts ?? []).map((p) => p.author),
  })
}
