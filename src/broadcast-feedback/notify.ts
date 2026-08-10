import { log } from "../lib/log.js"
import { telegramSendFormattedChunks } from "../lib/telegram-bot.js"
import { attachPromptMessageId } from "./intake.js"
import { broadcastFeedbackLayout, type BroadcastFeedbackLayout } from "./paths.js"
import type { BroadcastFeedbackRecord } from "./schemas.js"

/**
 * Ask the operator for detail after a `down` or `ambiguous` reaction. The
 * prompt carries only host-owned facts about the broadcast, never scraped
 * prose. The reply comes back through the Telegram chat handler.
 */

export type FeedbackNotifySend = (text: string) => Promise<{ messageId?: string }>

export const FEEDBACK_PROMPT_MAX = 900

export function renderFeedbackFollowupPrompt(
  record: BroadcastFeedbackRecord,
): string {
  const subject = record.subject ?? "this broadcast"
  const claim = record.auditClaim
  const lines = [
    record.state === "ambiguous"
      ? `You marked both reactions on ${subject}.`
      : `You marked ${subject} as not useful.`,
    ...(claim
      ? [`Claim: ${claim.type} · ${claim.direction} · ${claim.horizonHours}h`]
      : []),
    `Severity: ${record.severity ?? "unknown"}`,
    "",
    "Reply to this message and say what was wrong. Plain words are fine.",
    "The host turns your reply into bounded tags; it never sends your text to the harness.",
    "This request expires after 72 hours.",
  ]
  return lines.join("\n").slice(0, FEEDBACK_PROMPT_MAX)
}

async function defaultSend(text: string): Promise<{ messageId?: string }> {
  const token = process.env["TELEGRAM_BOT_TOKEN"]
  const operatorId = process.env["TELEGRAM_OPERATOR_ID"]
  if (!token || !operatorId) {
    log.warn("broadcast feedback follow-up skipped — telegram env unset")
    return {}
  }
  const result = await telegramSendFormattedChunks(fetch, token, operatorId, text)
  return result.messageIds[0] ? { messageId: result.messageIds[0] } : {}
}

export type RequestFollowupResult = Readonly<{
  sent: boolean
  promptMessageId?: string
  text: string
}>

export async function requestFeedbackFollowup(args: Readonly<{
  record: BroadcastFeedbackRecord
  layout?: BroadcastFeedbackLayout
  send?: FeedbackNotifySend
}>): Promise<RequestFollowupResult> {
  const layout = args.layout ?? broadcastFeedbackLayout()
  const text = renderFeedbackFollowupPrompt(args.record)
  const send = args.send ?? defaultSend
  try {
    const result = await send(text)
    if (result.messageId) {
      attachPromptMessageId({
        layout,
        feedbackId: args.record.feedbackId,
        promptMessageId: result.messageId,
      })
      return { sent: true, promptMessageId: result.messageId, text }
    }
    return { sent: true, text }
  } catch (error) {
    log.warn("broadcast feedback follow-up send failed", {
      feedbackId: args.record.feedbackId,
      detail: error instanceof Error ? error.message : "unknown",
    })
    return { sent: false, text }
  }
}
