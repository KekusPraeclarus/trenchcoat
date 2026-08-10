import { createHash } from "node:crypto"
import type { BroadcastFeedbackLayout } from "./paths.js"
import type { ResolvedBroadcast } from "./resolve.js"
import {
  appendFeedbackEvent,
  findFeedbackRecord,
  readPendingFollowups,
  withFeedbackLock,
  writePendingFollowups,
} from "./store.js"
import {
  feedbackStateFromReactions,
  followupRequiredFor,
  type BroadcastFeedbackRecord,
  type FeedbackState,
} from "./schemas.js"

/**
 * Apply one operator reaction transition. Every message part of a broadcast
 * maps to one feedbackId, so a reaction on part two updates the same record as
 * a reaction on part one. Replay of the same reaction set is a no-op.
 */

export type FeedbackIntakeOutcome =
  | "unchanged"
  | "recorded"
  | "followup-requested"
  | "followup-cancelled"

export type FeedbackIntakeResult = Readonly<{
  outcome: FeedbackIntakeOutcome
  record: BroadcastFeedbackRecord
  /** True when the host must ask the operator for detail over Telegram */
  needsFollowup: boolean
}>

export function feedbackIdForEvent(eventId: string): string {
  return `fb-${createHash("sha256").update(eventId).digest("hex").slice(0, 32)}`
}

export async function applyOperatorReaction(args: Readonly<{
  layout: BroadcastFeedbackLayout
  resolved: ResolvedBroadcast
  operatorUserId: string
  up: boolean
  down: boolean
  nowIso: string
  followupTtlHours: number
}>): Promise<FeedbackIntakeResult> {
  const state = feedbackStateFromReactions({ up: args.up, down: args.down })
  return withFeedbackLock(args.layout, async () => (
    commitReaction({ ...args, state })
  ))
}

function commitReaction(args: Readonly<{
  layout: BroadcastFeedbackLayout
  resolved: ResolvedBroadcast
  operatorUserId: string
  state: FeedbackState
  nowIso: string
  followupTtlHours: number
}>): FeedbackIntakeResult {
  const { index, event } = args.resolved
  const feedbackId = feedbackIdForEvent(event.eventId)
  const previous = findFeedbackRecord(args.layout, feedbackId)

  const base: BroadcastFeedbackRecord = {
    schema: 1,
    feedbackId,
    eventId: event.eventId,
    deliveryId: index.deliveryId,
    runId: event.runId,
    providerMessageId: index.messageId,
    partIndex: index.partIndex,
    partTotal: index.partTotal,
    ...(event.auditClaim ? { auditClaim: event.auditClaim } : {}),
    severity: event.severity,
    ...(event.auditClaim ? { subject: event.auditClaim.subject } : {}),
    operatorUserId: args.operatorUserId,
    state: args.state,
    firstReactionAt: previous?.firstReactionAt ?? args.nowIso,
    lastReactionAt: args.nowIso,
    followupStatus: previous?.followupStatus ?? "not-required",
    ...(previous?.followupRequestedAt
      ? { followupRequestedAt: previous.followupRequestedAt }
      : {}),
    ...(previous?.followupCompletedAt
      ? { followupCompletedAt: previous.followupCompletedAt }
      : {}),
    tags: previous?.tags ?? [],
    ...(previous?.derivedSummary ? { derivedSummary: previous.derivedSummary } : {}),
  }

  if (previous && previous.state === args.state) {
    return { outcome: "unchanged", record: previous, needsFollowup: false }
  }

  const wants = followupRequiredFor(args.state)
  const alreadyCompleted = previous?.followupStatus === "completed"

  if (wants && !alreadyCompleted) {
    const record: BroadcastFeedbackRecord = {
      ...base,
      followupStatus: "pending",
      followupRequestedAt: args.nowIso,
    }
    appendFeedbackEvent(args.layout, {
      schema: 1,
      recordedAt: args.nowIso,
      transition: "reaction",
      record,
    })
    upsertPending({
      layout: args.layout,
      record,
      nowIso: args.nowIso,
      followupTtlHours: args.followupTtlHours,
    })
    return { outcome: "followup-requested", record, needsFollowup: true }
  }

  // A final up or retracted state cancels an open detail request
  const cancelling = !wants && previous?.followupStatus === "pending"
  const record: BroadcastFeedbackRecord = {
    ...base,
    followupStatus: cancelling
      ? "cancelled"
      : alreadyCompleted
        ? "completed"
        : wants
          ? base.followupStatus
          : "not-required",
  }
  appendFeedbackEvent(args.layout, {
    schema: 1,
    recordedAt: args.nowIso,
    transition: cancelling ? "followup-cancelled" : "reaction",
    record,
  })
  if (cancelling) removePending(args.layout, feedbackId)
  return {
    outcome: cancelling ? "followup-cancelled" : "recorded",
    record,
    needsFollowup: false,
  }
}

function upsertPending(args: Readonly<{
  layout: BroadcastFeedbackLayout
  record: BroadcastFeedbackRecord
  nowIso: string
  followupTtlHours: number
}>): void {
  const file = readPendingFollowups(args.layout)
  const expiresAt = new Date(
    Date.parse(args.nowIso) + args.followupTtlHours * 3_600_000,
  ).toISOString()
  const next = file.pending.filter((entry) => entry.feedbackId !== args.record.feedbackId)
  next.push({
    feedbackId: args.record.feedbackId,
    eventId: args.record.eventId,
    state: args.record.state,
    requestedAt: args.nowIso,
    expiresAt,
    ...(args.record.subject ? { subject: args.record.subject } : {}),
  })
  writePendingFollowups(args.layout, next)
}

export function removePending(
  layout: BroadcastFeedbackLayout,
  feedbackId: string,
): void {
  const file = readPendingFollowups(layout)
  const next = file.pending.filter((entry) => entry.feedbackId !== feedbackId)
  if (next.length !== file.pending.length) writePendingFollowups(layout, next)
}

/** Attach the Telegram prompt message id after a successful send */
export function attachPromptMessageId(args: Readonly<{
  layout: BroadcastFeedbackLayout
  feedbackId: string
  promptMessageId: string
}>): void {
  const file = readPendingFollowups(args.layout)
  const next = file.pending.map((entry) => (
    entry.feedbackId === args.feedbackId
      ? { ...entry, promptMessageId: args.promptMessageId }
      : entry
  ))
  writePendingFollowups(args.layout, next)
}
