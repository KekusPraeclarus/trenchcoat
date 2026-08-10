import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { extractJsonObject } from "../harness/parse-json.js"
import { FEEDBACK_FOLLOWUP_PROMPT } from "../prompts/host.js"
import { runOneShotSession, type SessionOptions, type SessionResult } from "../orchestrator/session.js"
import {
  bindFeedbackReply,
  renderFeedbackAck,
  FEEDBACK_AMBIGUOUS_REPLY,
  FEEDBACK_RETRY_REPLY,
} from "../chat/pending-broadcast-feedback.js"
import { broadcastFeedbackLayout, type BroadcastFeedbackLayout } from "./paths.js"
import { removePending } from "./intake.js"
import {
  appendFeedbackEvent,
  findFeedbackRecord,
  readPendingFollowups,
  withFeedbackLock,
  writePendingFollowups,
} from "./store.js"
import {
  FeedbackFollowupResultSchema,
  type BroadcastFeedbackRecord,
  type FeedbackFollowupResult,
} from "./schemas.js"

/**
 * Turn one natural-language operator reply into bounded tags. The reply is
 * confined to an evidence file, the classifier reads that path only, and only
 * the parsed tags and one short summary reach the ledger (INV-B3, INV-S24).
 */

export type FollowupSessionFn = (opts: SessionOptions) => Promise<SessionResult>

export const FOLLOWUP_CLASSIFIER_PROMPT = FEEDBACK_FOLLOWUP_PROMPT

export const FEEDBACK_EVIDENCE_MAX = 4_000

export function writeFollowupEvidence(args: Readonly<{
  layout: BroadcastFeedbackLayout
  feedbackId: string
  replyText: string
  nowIso: string
}>): string {
  mkdirSync(args.layout.followupEvidence, { recursive: true, mode: 0o700 })
  const path = join(args.layout.followupEvidence, `${args.feedbackId}.json`)
  const body = {
    schema: 1,
    feedbackId: args.feedbackId,
    capturedAt: args.nowIso,
    trust: "untrusted-external",
    reply: args.replyText.slice(0, FEEDBACK_EVIDENCE_MAX),
  }
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 })
  return path
}

export async function classifyFollowupReply(args: Readonly<{
  repoRoot: string
  evidencePath: string
  model: string
  runSession?: FollowupSessionFn
}>): Promise<
  { ok: true; result: FeedbackFollowupResult } | { ok: false; reason: string }
> {
  const runSession = args.runSession ?? runOneShotSession
  const session = await runSession({
    prompt: [FOLLOWUP_CLASSIFIER_PROMPT, "", `replyPath=${args.evidencePath}`].join("\n"),
    cwd: args.repoRoot,
    model: args.model,
    mode: "ask",
    sandbox: true,
  })
  if (session.status !== "finished" || !session.text) {
    return { ok: false, reason: session.error ?? "session failed" }
  }
  try {
    return {
      ok: true,
      result: FeedbackFollowupResultSchema.parse(extractJsonObject(session.text)),
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "malformed" }
  }
}

export type ApplyFollowupOutcome =
  | Readonly<{ ok: true; record: BroadcastFeedbackRecord }>
  | Readonly<{ ok: false; reason: "unknown-feedback" | "not-pending" }>

/** Complete one pending request with parsed tags. Raw prose never lands here. */
export async function applyFollowupResult(args: Readonly<{
  layout?: BroadcastFeedbackLayout
  feedbackId: string
  result: FeedbackFollowupResult
  nowIso: string
}>): Promise<ApplyFollowupOutcome> {
  const layout = args.layout ?? broadcastFeedbackLayout()
  return withFeedbackLock(layout, async () => {
    const previous = findFeedbackRecord(layout, args.feedbackId)
    if (!previous) return { ok: false, reason: "unknown-feedback" } as const
    if (previous.followupStatus !== "pending") {
      return { ok: false, reason: "not-pending" } as const
    }
    const record: BroadcastFeedbackRecord = {
      ...previous,
      followupStatus: "completed",
      followupCompletedAt: args.nowIso,
      tags: args.result.tags,
      derivedSummary: args.result.summary,
    }
    appendFeedbackEvent(layout, {
      schema: 1,
      recordedAt: args.nowIso,
      transition: "followup-completed",
      record,
    })
    removePending(layout, args.feedbackId)
    return { ok: true, record } as const
  })
}

/**
 * Full Telegram path: bind the reply, confine it, classify it, and record the
 * bounded tags. Returns null when no open request matches, so the chat handler
 * continues with normal conversation.
 */
export async function handleFeedbackReply(args: Readonly<{
  text: string
  replyToMessageId?: string
  repoRoot: string
  model: string
  nowIso: string
  layout?: BroadcastFeedbackLayout
  runSession?: FollowupSessionFn
}>): Promise<string | null> {
  const layout = args.layout ?? broadcastFeedbackLayout()
  await expireStaleFollowups({ layout, nowIso: args.nowIso })
  const binding = bindFeedbackReply({
    pending: readPendingFollowups(layout).pending,
    nowIso: args.nowIso,
    ...(args.replyToMessageId ? { replyToMessageId: args.replyToMessageId } : {}),
  })
  if (binding.kind === "none") return null
  if (binding.kind === "ambiguous") return FEEDBACK_AMBIGUOUS_REPLY

  const evidencePath = writeFollowupEvidence({
    layout,
    feedbackId: binding.feedbackId,
    replyText: args.text,
    nowIso: args.nowIso,
  })
  const classified = await classifyFollowupReply({
    repoRoot: args.repoRoot,
    evidencePath,
    model: args.model,
    ...(args.runSession ? { runSession: args.runSession } : {}),
  })
  if (!classified.ok) return FEEDBACK_RETRY_REPLY

  const applied = await applyFollowupResult({
    layout,
    feedbackId: binding.feedbackId,
    result: classified.result,
    nowIso: args.nowIso,
  })
  if (!applied.ok) return FEEDBACK_RETRY_REPLY
  return renderFeedbackAck(classified.result.tags)
}

/**
 * Expire open requests after the configured window. The original down signal
 * survives; only the detail request ends.
 */
export async function expireStaleFollowups(args: Readonly<{
  layout?: BroadcastFeedbackLayout
  nowIso: string
}>): Promise<number> {
  const layout = args.layout ?? broadcastFeedbackLayout()
  return withFeedbackLock(layout, async () => {
    const nowMs = Date.parse(args.nowIso)
    const file = readPendingFollowups(layout)
    const expired = file.pending.filter((entry) => Date.parse(entry.expiresAt) <= nowMs)
    if (expired.length === 0) return 0
    for (const entry of expired) {
      const previous = findFeedbackRecord(layout, entry.feedbackId)
      if (!previous) continue
      appendFeedbackEvent(layout, {
        schema: 1,
        recordedAt: args.nowIso,
        transition: "followup-expired",
        record: { ...previous, followupStatus: "expired" },
      })
    }
    writePendingFollowups(
      layout,
      file.pending.filter((entry) => Date.parse(entry.expiresAt) > nowMs),
    )
    return expired.length
  })
}
