import type Database from "better-sqlite3"
import { resolveBroadcastByEventId } from "./resolve.js"
import { currentFeedbackRecords } from "./store.js"
import type { BroadcastFeedbackLayout } from "./paths.js"
import type { BroadcastFeedbackRecord, FeedbackState } from "./schemas.js"

/**
 * Runtime operator preference examples for the broadcast worthiness gate (ADR 043).
 * Uses delivered system broadcast text only — never raw Telegram follow-up prose.
 */

export const OPERATOR_LIKED_EXAMPLES_MAX = 12
export const OPERATOR_DISLIKED_EXAMPLES_MAX = 8
export const OPERATOR_EXAMPLE_TEXT_MAX = 280

export type OperatorFeedbackExample = Readonly<{
  eventId: string
  text: string
  subject?: string
  severity?: string
  claimType?: string
  reactedAt: string
  tags?: readonly string[]
  derivedSummary?: string
}>

export type OperatorFeedbackExamples = Readonly<{
  liked: readonly OperatorFeedbackExample[]
  disliked: readonly OperatorFeedbackExample[]
}>

function clipText(text: string, max: number): string {
  return text.trim().replace(/\s+/gu, " ").slice(0, max)
}

function isDislikedState(state: FeedbackState): boolean {
  return state === "down" || state === "ambiguous"
}

function recordToExample(
  db: Database.Database,
  record: BroadcastFeedbackRecord,
): OperatorFeedbackExample | undefined {
  const resolved = resolveBroadcastByEventId(db, record.eventId)
  if (!resolved.ok) return undefined
  const text = clipText(resolved.resolved.event.text, OPERATOR_EXAMPLE_TEXT_MAX)
  if (text.length < 1) return undefined
  return {
    eventId: record.eventId,
    text,
    ...(record.subject ? { subject: record.subject } : {}),
    ...(record.auditClaim?.subject && !record.subject
      ? { subject: record.auditClaim.subject }
      : {}),
    ...(record.severity ? { severity: record.severity } : {}),
    ...(record.auditClaim?.type ? { claimType: record.auditClaim.type } : {}),
    reactedAt: record.lastReactionAt,
    ...(record.tags.length > 0 ? { tags: [...record.tags] } : {}),
    ...(record.derivedSummary
      ? { derivedSummary: clipText(record.derivedSummary, OPERATOR_EXAMPLE_TEXT_MAX) }
      : {}),
  }
}

/** Latest operator 👍/👎 examples within the feedback history window. */
export function loadOperatorFeedbackExamples(args: Readonly<{
  layout: BroadcastFeedbackLayout
  db: Database.Database
  nowIso: string
  historyDays?: number
  likedMax?: number
  dislikedMax?: number
}>): OperatorFeedbackExamples {
  const historyDays = Math.max(1, args.historyDays ?? 30)
  const likedMax = Math.max(0, args.likedMax ?? OPERATOR_LIKED_EXAMPLES_MAX)
  const dislikedMax = Math.max(0, args.dislikedMax ?? OPERATOR_DISLIKED_EXAMPLES_MAX)
  const cutoffMs = Date.parse(args.nowIso) - historyDays * 86_400_000

  const liked: OperatorFeedbackExample[] = []
  const disliked: OperatorFeedbackExample[] = []
  const sorted = [...currentFeedbackRecords(args.layout)]
    .filter((record) => Date.parse(record.lastReactionAt) >= cutoffMs)
    .sort((a, b) => b.lastReactionAt.localeCompare(a.lastReactionAt))

  for (const record of sorted) {
    if (record.state === "retracted") continue
    if (record.state === "up") {
      if (liked.length >= likedMax) continue
      const example = recordToExample(args.db, record)
      if (example) liked.push(example)
      continue
    }
    if (isDislikedState(record.state)) {
      if (disliked.length >= dislikedMax) continue
      const example = recordToExample(args.db, record)
      if (example) disliked.push(example)
    }
  }

  return { liked, disliked }
}
