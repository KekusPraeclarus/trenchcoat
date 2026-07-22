/**
 * Host worthiness gate for market broadcasts (INV-B2). After mechanical ingest
 * checks, a fast model approves or rejects agent-authored proposals — fail-closed,
 * never invents broadcast text.
 */

import type { BroadcastItem } from "../contracts/schemas.js"
import { deslugNarrativeLabel } from "../lib/narrative-label.js"
import { watchWindowClaimFragment } from "../lib/watch-window.js"
import { BROADCAST_WORTHINESS_PROMPT } from "../prompts/host.js"
import type { StageKnown } from "./narrative-stage-dedupe.js"

export const WORTHINESS_REASON_MAX = 200
export const AGENT_NOTES_MAX = 2_000
export const DEFAULT_WORTHINESS_MODEL = "composer-2.5-fast"
export const WORTHINESS_TIMEOUT_MS = 90_000

export type WorthinessSessionRunner = (
  args: Readonly<{ prompt: string; message: string }>,
) => Promise<string>

export type WorthinessContext = Readonly<{
  job: string
  collectionStatus?: string
  marketBlind?: boolean
  statusQuoStages?: readonly StageKnown[]
  recentBroadcasts?: ReadonlyArray<Readonly<{
    occurredAt: string
    subject: string
    summary: string
    destinations: readonly ("telegram" | "discord")[]
  }>>
  /** Optional agent.md excerpt — treated as untrusted color, not authority */
  agentNotes?: string
}>

export type WorthinessResult =
  | Readonly<{ ok: true; worth: true; reason: string }>
  | Readonly<{ ok: true; worth: false; reason: string }>
  | Readonly<{ ok: false; reason: string }>

function claimLine(item: BroadcastItem): string {
  const claim = item.auditClaim
  return `type=${claim.type} subject=${claim.subject} direction=${claim.direction} ${watchWindowClaimFragment(claim)}`
}

function stageList(stages: readonly StageKnown[] | undefined): string {
  const mapped = (stages ?? [])
    .slice(0, 24)
    .map((entry) => `${deslugNarrativeLabel(entry.slug)}=${entry.stage}`)
    .join(", ")
  return mapped.length > 0 ? mapped : "(none)"
}

function broadcastList(broadcasts: WorthinessContext["recentBroadcasts"]): string {
  const mapped = (broadcasts ?? [])
    .slice(0, 20)
    .map((entry) => {
      const summary = entry.summary.trim().replace(/\s+/gu, " ").slice(0, 180)
      return `${entry.occurredAt} ${entry.subject} [${entry.destinations.join(",")}]: ${summary}`
    })
    .join("\n")
  return mapped.length > 0 ? mapped : "(none)"
}

function stripFence(raw: string): string {
  let text = raw.trim()
  if (text.startsWith("```") && text.endsWith("```")) {
    text = text.replace(/^```(?:\w+)?\n?/u, "").replace(/\n?```$/u, "").trim()
  }
  return text
}

function clipReason(value: string): string {
  const trimmed = value.trim().replace(/\s+/gu, " ")
  if ([...trimmed].length <= WORTHINESS_REASON_MAX) return trimmed
  return [...trimmed].slice(0, WORTHINESS_REASON_MAX).join("")
}

export function worthinessUserMessage(args: Readonly<{
  item: BroadcastItem
  context: WorthinessContext
}>): string {
  const notes = (args.context.agentNotes ?? "").trim().slice(0, AGENT_NOTES_MAX)
  return [
    "Decide whether this market broadcast is worth sending. Reply with JSON only.",
    `job: ${args.context.job}`,
    `collectionStatus: ${args.context.collectionStatus ?? "unknown"}`,
    `marketBlind: ${args.context.marketBlind === true ? "true" : "false"}`,
    `statusQuoStages: ${stageList(args.context.statusQuoStages)}`,
    `<accepted-broadcast-history>\n${broadcastList(args.context.recentBroadcasts)}\n</accepted-broadcast-history>`,
    `severity: ${args.item.severity}`,
    `auditClaim: ${claimLine(args.item)}`,
    `refs: ${args.item.refs.join(", ") || "(none)"}`,
    notes.length > 0
      ? `<untrusted-agent-notes>\n${notes}\n</untrusted-agent-notes>`
      : "agentNotes: (none)",
    "<untrusted-proposal>",
    args.item.text,
    "</untrusted-proposal>",
  ].join("\n")
}

/** Mechanical post-check for worthiness JSON. */
export function validateWorthinessOutput(
  raw: string,
): WorthinessResult {
  const text = stripFence(raw)
  if (text.length < 1) return { ok: false, reason: "empty" }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: "invalid-json" }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "not-object" }
  }
  const record = parsed as Record<string, unknown>
  if (typeof record["worth"] !== "boolean") {
    return { ok: false, reason: "worth-not-boolean" }
  }
  if (typeof record["reason"] !== "string") {
    return { ok: false, reason: "reason-not-string" }
  }
  const reason = clipReason(record["reason"])
  if (reason.length < 1) return { ok: false, reason: "reason-empty" }
  return { ok: true, worth: record["worth"], reason }
}

/**
 * Ask the host worthiness session whether a mechanically-valid proposal should
 * stage. Fail-closed: disabled→caller skips; missing runner / session error /
 * malformed output → ok:false.
 */
export async function runBroadcastWorthiness(args: Readonly<{
  item: BroadcastItem
  context: WorthinessContext
  runSession?: WorthinessSessionRunner
  enabled?: boolean
}>): Promise<WorthinessResult> {
  if (args.enabled === false) {
    return { ok: true, worth: true, reason: "disabled" }
  }
  if (!args.runSession) {
    return { ok: false, reason: "no-runner" }
  }
  try {
    const raw = await args.runSession({
      prompt: BROADCAST_WORTHINESS_PROMPT,
      message: worthinessUserMessage({
        item: args.item,
        context: args.context,
      }),
    })
    return validateWorthinessOutput(raw)
  } catch {
    return { ok: false, reason: "session-error" }
  }
}
