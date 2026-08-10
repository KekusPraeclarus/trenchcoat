import type { PendingFollowup } from "../broadcast-feedback/schemas.js"

/**
 * Bind one Telegram reply to one open feedback request. A reply to the host
 * prompt always wins. A bare message binds only when exactly one request is
 * open, so detail never lands on the wrong broadcast.
 */

export type FeedbackBinding =
  | Readonly<{ kind: "bound"; feedbackId: string }>
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "ambiguous"; open: number }>

export function bindFeedbackReply(args: Readonly<{
  pending: readonly PendingFollowup[]
  nowIso: string
  replyToMessageId?: string
}>): FeedbackBinding {
  const nowMs = Date.parse(args.nowIso)
  const open = args.pending.filter((entry) => Date.parse(entry.expiresAt) > nowMs)
  if (open.length === 0) return { kind: "none" }

  if (args.replyToMessageId) {
    const matched = open.find((entry) => entry.promptMessageId === args.replyToMessageId)
    if (matched) return { kind: "bound", feedbackId: matched.feedbackId }
    return { kind: "none" }
  }

  if (open.length === 1) return { kind: "bound", feedbackId: open[0]!.feedbackId }
  return { kind: "ambiguous", open: open.length }
}

export const FEEDBACK_AMBIGUOUS_REPLY =
  "Several feedback requests are open. Reply directly to the request you mean."

export function renderFeedbackAck(tags: readonly string[]): string {
  return `Feedback recorded: ${tags.join(", ")}.`
}

export const FEEDBACK_RETRY_REPLY =
  "I could not read that feedback. Say what was wrong in one or two sentences."
