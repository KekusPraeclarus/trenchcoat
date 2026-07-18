import { sha256Json } from "../lib/canonical-json.js"
import type {
  FcEngagementDecision,
  FcEngagementFile,
  FcEngagementProposalFile,
  FcEngagementProposalItem,
} from "../contracts/schemas.js"
import { FcEngagementProposalFileSchema } from "../contracts/schemas.js"
import type { EngagementCaps } from "./x-engagement.js"

export type FcEngagementApplyResult = Readonly<{
  decisions: readonly FcEngagementDecision[]
  accepted: readonly FcEngagementDecision[]
  rejected: readonly FcEngagementDecision[]
  nextState: FcEngagementFile
}>

export function parseFcEngagementProposal(raw: unknown): FcEngagementProposalFile {
  return FcEngagementProposalFileSchema.parse(raw)
}

export function fcEngagementActionId(
  item: FcEngagementProposalItem,
  runId: string,
): `sha256:${string}` {
  return sha256Json({
    action: item.action,
    castHash: item.castHash.toLowerCase(),
    runId,
    reasonCode: item.reasonCode,
  })
}

function dayKey(iso: string): string {
  return iso.slice(0, 10)
}

function ensureDaily(file: FcEngagementFile, nowIso: string): FcEngagementFile {
  const day = dayKey(nowIso)
  if (file.daily.day === day) return file
  return {
    ...file,
    daily: { day, likes: 0 },
  }
}

export function fcLikesInWindow(
  file: FcEngagementFile,
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

/**
 * Apply bot Farcaster like choices. Likes must target cast hashes from the
 * same-run for-you feed. Follow/unfollow are host-only (lifecycle sync).
 */
export function applyFcEngagementChoices(args: Readonly<{
  proposal: FcEngagementProposalFile
  state: FcEngagementFile
  caps: EngagementCaps
  nowIso: string
  fypCastHashes?: ReadonlySet<string> | readonly string[]
}>): FcEngagementApplyResult {
  let state = ensureDaily(args.state, args.nowIso)
  if (!args.caps.enabled) {
    return {
      decisions: [],
      accepted: [],
      rejected: [],
      nextState: state,
    }
  }

  const fypHashes = new Set(
    [...(args.fypCastHashes ?? [])].map((h) => h.toLowerCase()),
  )

  const knownActionIds = new Set([
    ...state.decisions.map((d) => d.actionId),
    ...state.receipts.map((r) => r.actionId),
  ])

  // Subscription state: casts already liked, independent of runId
  const likedCastHashes = new Set([
    ...state.likedCastHashes.map((h) => h.toLowerCase()),
    ...state.receipts
      .filter((r) => r.action === "like" && r.verified)
      .map((r) => r.target.toLowerCase()),
  ])

  let likesInWin = fcLikesInWindow(
    state,
    args.nowIso,
    args.caps.like_window_minutes,
  )
  let likesDay = state.daily.likes

  const decisions: FcEngagementDecision[] = []
  const accepted: FcEngagementDecision[] = []
  const rejected: FcEngagementDecision[] = []
  const pending = [...state.pendingActionIds]

  for (const item of args.proposal.items) {
    const actionId = fcEngagementActionId(item, args.proposal.runId)
    const target = item.castHash.toLowerCase()
    const base = {
      schema: 1 as const,
      actionId,
      action: "like" as const,
      target: item.castHash,
      reasonCode: item.reasonCode,
      topics: item.topics,
      runId: args.proposal.runId,
      decidedAt: args.nowIso,
    }

    const reject = (reason: string): void => {
      const decision: FcEngagementDecision = {
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

    if (!fypHashes.has(target)) {
      reject("cast_hash_not_in_fyp")
      continue
    }
    if (likedCastHashes.has(target)) {
      reject("already_liked")
      continue
    }
    if (likesInWin >= args.caps.likes_per_window) {
      reject("like_rate_limit")
      continue
    }
    likesInWin += 1
    likesDay += 1

    const decision: FcEngagementDecision = { ...base, accepted: true }
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
      pendingActionIds: [...new Set(pending)],
      decisions: [...state.decisions, ...decisions],
      daily: {
        day: dayKey(args.nowIso),
        likes: likesDay,
      },
    },
  }
}
