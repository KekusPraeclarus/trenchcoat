import { homedir } from "node:os"
import { join } from "node:path"
import type Database from "better-sqlite3"
import { systemClock } from "../lib/clock.js"
import { loadConfig } from "../lib/config.js"
import { log } from "../lib/log.js"
import { broadcastFeedbackLayout } from "../broadcast-feedback/paths.js"
import { applyOperatorReaction, type FeedbackIntakeResult } from "../broadcast-feedback/intake.js"
import {
  openRouterDbReadOnly,
  recentIndexedDiscordMessages,
  resolveBroadcastByMessageId,
} from "../broadcast-feedback/resolve.js"
import {
  FEEDBACK_DOWN_EMOJI,
  FEEDBACK_UP_EMOJI,
} from "../broadcast-feedback/schemas.js"

/**
 * Gateway side of operator broadcast feedback (ADR 043, INV-B6). Only the
 * configured operator, in the configured channel, on a delivered
 * `finding.broadcast`, can change feedback state. Everything else is ignored.
 */

export type FeedbackGateReason =
  | "feedback-disabled"
  | "wrong-channel"
  | "not-operator"
  | "operator-unset"
  | "unsupported-emoji"

export type FeedbackGateResult =
  | Readonly<{ admit: true }>
  | Readonly<{ admit: false; reason: FeedbackGateReason }>

export type FeedbackConfigSlice = Readonly<{
  enabled: boolean
  channelId?: string
  followupTtlHours: number
  reconcileMaxMessages: number
}>

export function feedbackConfigSlice(): FeedbackConfigSlice {
  const feedback = loadConfig().broadcast.feedback
  return {
    enabled: feedback.enabled,
    ...(feedback.channel_id ? { channelId: feedback.channel_id } : {}),
    followupTtlHours: feedback.followup_ttl_hours,
    reconcileMaxMessages: feedback.reconcile_max_messages,
  }
}

export function operatorUserId(): string | undefined {
  const raw = process.env["DISCORD_OPERATOR_USER_ID"]?.trim()
  return raw && /^\d{17,20}$/u.test(raw) ? raw : undefined
}

export function gateReactionEvent(args: Readonly<{
  config: FeedbackConfigSlice
  operatorUserId?: string
  reactingUserId: string
  channelId: string
  emoji: string
}>): FeedbackGateResult {
  if (!args.config.enabled || !args.config.channelId) {
    return { admit: false, reason: "feedback-disabled" }
  }
  if (!args.operatorUserId) return { admit: false, reason: "operator-unset" }
  if (args.channelId !== args.config.channelId) {
    return { admit: false, reason: "wrong-channel" }
  }
  if (args.reactingUserId !== args.operatorUserId) {
    return { admit: false, reason: "not-operator" }
  }
  if (args.emoji !== FEEDBACK_UP_EMOJI && args.emoji !== FEEDBACK_DOWN_EMOJI) {
    return { admit: false, reason: "unsupported-emoji" }
  }
  return { admit: true }
}

export function routerDbPath(home = join(homedir(), ".trenchcoat")): string {
  return join(home, "router.sqlite3")
}

export type ReactionSnapshot = Readonly<{ up: boolean; down: boolean }>

/**
 * Apply the operator's current reaction set for one broadcast message. The
 * caller reads the live reaction set, so add and remove share one path and a
 * replay of the same set changes nothing.
 */
export async function applyBroadcastReaction(args: Readonly<{
  db: Database.Database
  messageId: string
  operatorUserId: string
  reactions: ReactionSnapshot
  config: FeedbackConfigSlice
  home?: string
  nowIso?: string
}>): Promise<FeedbackIntakeResult | { skipped: string }> {
  const resolved = resolveBroadcastByMessageId(args.db, args.messageId)
  if (!resolved.ok) return { skipped: resolved.reason }
  return applyOperatorReaction({
    layout: broadcastFeedbackLayout(args.home),
    resolved: resolved.resolved,
    operatorUserId: args.operatorUserId,
    up: args.reactions.up,
    down: args.reactions.down,
    nowIso: args.nowIso ?? systemClock.nowIso(),
    followupTtlHours: args.config.followupTtlHours,
  })
}

/**
 * Re-read reactions on the latest indexed broadcasts. Startup uses this so a
 * reaction added while the listener was down still lands in the ledger.
 */
export async function reconcileBroadcastFeedback(args: Readonly<{
  db: Database.Database
  operatorUserId: string
  config: FeedbackConfigSlice
  readReactions: (messageId: string) => Promise<ReactionSnapshot | undefined>
  home?: string
  nowIso?: string
}>): Promise<number> {
  if (!args.config.enabled || !args.config.channelId) return 0
  let changed = 0
  for (const row of recentIndexedDiscordMessages(args.db, args.config.reconcileMaxMessages)) {
    let reactions: ReactionSnapshot | undefined
    try {
      reactions = await args.readReactions(row.messageId)
    } catch {
      continue
    }
    if (!reactions) continue
    if (!reactions.up && !reactions.down) continue
    const result = await applyBroadcastReaction({
      db: args.db,
      messageId: row.messageId,
      operatorUserId: args.operatorUserId,
      reactions,
      config: args.config,
      ...(args.home ? { home: args.home } : {}),
      ...(args.nowIso ? { nowIso: args.nowIso } : {}),
    })
    if ("outcome" in result && result.outcome !== "unchanged") changed += 1
  }
  return changed
}

export function openFeedbackRouterDb(home?: string): Database.Database | undefined {
  const db = openRouterDbReadOnly(routerDbPath(home))
  if (!db) log.warn("broadcast feedback: router database is not readable")
  return db
}
