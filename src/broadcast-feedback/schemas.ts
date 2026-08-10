import { z } from "zod"

/**
 * Operator broadcast feedback (ADR 043, INV-B6). Only the configured Discord
 * operator can change these records. Raw Telegram prose never lands here — the
 * ledger keeps bounded tags and one host-derived summary.
 */

export const FeedbackStateSchema = z.enum(["up", "down", "ambiguous", "retracted"])
export type FeedbackState = z.infer<typeof FeedbackStateSchema>

export const FeedbackFollowupStatusSchema = z.enum([
  "not-required",
  "pending",
  "completed",
  "expired",
  "cancelled",
])
export type FeedbackFollowupStatus = z.infer<typeof FeedbackFollowupStatusSchema>

export const FeedbackTagSchema = z.enum([
  "tone",
  "jargon",
  "timing",
  "accuracy",
  "wrong-subject",
  "too-long",
  "too-short",
  "missing-context",
  "other",
])
export type FeedbackTag = z.infer<typeof FeedbackTagSchema>

/** Strict classifier output: bounded tags plus one short derived summary */
export const FeedbackFollowupResultSchema = z.object({
  schema: z.literal(1),
  tags: z.array(FeedbackTagSchema).min(1).max(9),
  summary: z.string().min(1).max(280),
})
export type FeedbackFollowupResult = z.infer<typeof FeedbackFollowupResultSchema>

const IsoTimestamp = z.string().min(20).max(64)
const DiscordId = z.string().regex(/^\d{17,20}$/u)

export const FeedbackAuditClaimSchema = z.object({
  type: z.string().min(1).max(64),
  subject: z.string().min(1).max(256),
  direction: z.string().min(1).max(32),
  horizonHours: z.number().int().min(1).max(168),
  verificationRule: z.string().min(1).max(64),
})

export const BroadcastFeedbackRecordSchema = z.object({
  schema: z.literal(1),
  /** Stable per delivered event; all message parts share one record */
  feedbackId: z.string().min(8).max(128),
  eventId: z.string().min(8).max(128),
  deliveryId: z.string().min(1).max(256),
  runId: z.string().min(1).max(128),
  providerMessageId: DiscordId,
  partIndex: z.number().int().min(0).max(64),
  partTotal: z.number().int().min(1).max(64),
  auditClaim: FeedbackAuditClaimSchema.optional(),
  severity: z.string().min(1).max(32).optional(),
  subject: z.string().min(1).max(256).optional(),
  operatorUserId: DiscordId,
  state: FeedbackStateSchema,
  firstReactionAt: IsoTimestamp,
  lastReactionAt: IsoTimestamp,
  followupStatus: FeedbackFollowupStatusSchema,
  followupRequestedAt: IsoTimestamp.optional(),
  followupCompletedAt: IsoTimestamp.optional(),
  tags: z.array(FeedbackTagSchema).max(9).default([]),
  derivedSummary: z.string().max(280).optional(),
})
export type BroadcastFeedbackRecord = z.infer<typeof BroadcastFeedbackRecordSchema>

/** One append-only ledger line: the full record after the transition */
export const BroadcastFeedbackEventSchema = z.object({
  schema: z.literal(1),
  recordedAt: IsoTimestamp,
  transition: z.enum([
    "reaction",
    "followup-requested",
    "followup-completed",
    "followup-expired",
    "followup-cancelled",
  ]),
  record: BroadcastFeedbackRecordSchema,
})
export type BroadcastFeedbackEvent = z.infer<typeof BroadcastFeedbackEventSchema>

export const PendingFollowupSchema = z.object({
  feedbackId: z.string().min(8).max(128),
  eventId: z.string().min(8).max(128),
  state: FeedbackStateSchema,
  requestedAt: IsoTimestamp,
  expiresAt: IsoTimestamp,
  /** Telegram message id of the host prompt, when the send succeeded */
  promptMessageId: z.string().min(1).max(64).optional(),
  subject: z.string().max(256).optional(),
})
export type PendingFollowup = z.infer<typeof PendingFollowupSchema>

export const PendingFollowupsFileSchema = z.object({
  schema: z.literal(1),
  pending: z.array(PendingFollowupSchema).max(200).default([]),
})
export type PendingFollowupsFile = z.infer<typeof PendingFollowupsFileSchema>

export const FEEDBACK_UP_EMOJI = "👍"
export const FEEDBACK_DOWN_EMOJI = "👎"

/**
 * Both reactions mean ambiguous; no reaction means retracted. One reaction wins
 * on its own. The rule is total, so a replay of the same reaction set always
 * gives the same state.
 */
export function feedbackStateFromReactions(args: Readonly<{
  up: boolean
  down: boolean
}>): FeedbackState {
  if (args.up && args.down) return "ambiguous"
  if (args.up) return "up"
  if (args.down) return "down"
  return "retracted"
}

/** `down` and `ambiguous` need operator detail; `up` and `retracted` do not */
export function followupRequiredFor(state: FeedbackState): boolean {
  return state === "down" || state === "ambiguous"
}
