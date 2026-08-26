/**
 * Host worthiness gate for market broadcasts (INV-B2). After mechanical ingest
 * checks, a fast model approves or rejects agent-authored proposals — fail-closed,
 * never invents broadcast text. Uses claim, refs, history, and operator examples.
 */

import type { AuditClaim, BroadcastItem } from "../contracts/schemas.js"
import type { OperatorFeedbackExamples } from "../broadcast-feedback/worthiness-examples.js"
import { sha256Json } from "../lib/canonical-json.js"
import { deslugNarrativeLabel } from "../lib/narrative-label.js"
import { BROADCAST_WORTHINESS_PROMPT } from "../prompts/host.js"
import type { StageKnown } from "./narrative-stage-dedupe.js"

export const WORTHINESS_REASON_MAX = 200
export const DEFAULT_WORTHINESS_MODEL = "composer-2.5-fast"
export const WORTHINESS_TIMEOUT_MS = 90_000
export const WORTHINESS_CANDIDATE_TEXT_MAX = 2_000

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
    status?: "accepted" | "staged"
  }>>
}>

export type WorthinessResult =
  | Readonly<{ ok: true; worth: true; reason: string }>
  | Readonly<{ ok: true; worth: false; reason: string }>
  | Readonly<{ ok: false; reason: string }>

/** Stable hash over auditClaim fields only (subject lowercased + trimmed). */
export function claimHash(auditClaim: AuditClaim): `sha256:${string}` {
  return sha256Json({
    type: auditClaim.type,
    subject: auditClaim.subject.trim().toLowerCase(),
    direction: auditClaim.direction,
    horizonHours: auditClaim.horizonHours,
    verificationRule: auditClaim.verificationRule,
  })
}

function claimLine(claim: AuditClaim): string {
  return [
    `type=${claim.type}`,
    `subject=${claim.subject}`,
    `direction=${claim.direction}`,
    `horizonHours=${claim.horizonHours}`,
    `verificationRule=${claim.verificationRule}`,
  ].join(" ")
}

function stageList(stages: readonly StageKnown[] | undefined): string {
  const mapped = (stages ?? [])
    .slice(0, 24)
    .map((entry) => `${deslugNarrativeLabel(entry.slug)}=${entry.stage}`)
    .join(", ")
  return mapped.length > 0 ? mapped : "(none)"
}

function broadcastList(
  broadcasts: WorthinessContext["recentBroadcasts"],
  status: "accepted" | "staged",
): string {
  const mapped = (broadcasts ?? [])
    .filter((entry) => (entry.status ?? "accepted") === status)
    .slice(0, 20)
    .map((entry) => {
      const summary = entry.summary.trim().replace(/\s+/gu, " ").slice(0, 180)
      return `${entry.occurredAt} ${entry.subject} [${entry.destinations.join(",")}]: ${summary}`
    })
    .join("\n")
  return mapped.length > 0 ? mapped : "(none)"
}

function operatorExampleList(
  examples: OperatorFeedbackExamples["liked"] | OperatorFeedbackExamples["disliked"],
): string {
  if (examples.length < 1) return "(none)"
  return examples
    .map((entry, index) => {
      const meta = [
        entry.claimType,
        entry.severity,
        entry.subject,
      ].filter(Boolean).join(" ")
      const tags = entry.tags && entry.tags.length > 0
        ? ` tags=${entry.tags.join(",")}`
        : ""
      const note = entry.derivedSummary
        ? ` note=${entry.derivedSummary.slice(0, 120)}`
        : ""
      return `${index + 1}. [${entry.reactedAt}] ${meta}${tags}${note}\n   ${entry.text}`
    })
    .join("\n")
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
  /** Operator-approved guidance lines (ADR 043); bounded host text only */
  guidance?: readonly string[]
  /** Live 👍/👎 examples from delivered broadcasts (system text only) */
  operatorExamples?: OperatorFeedbackExamples
}>): string {
  const guidance = args.guidance ?? []
  const candidateText = args.item.text.trim().replace(/\s+/gu, " ").slice(0, WORTHINESS_CANDIDATE_TEXT_MAX)
  const examples = args.operatorExamples
  return [
    "Decide whether this market broadcast is worth sending. Reply with JSON only.",
    ...(guidance.length > 0
      ? [`<operator-guidance>\n${guidance.map((line) => `- ${line}`).join("\n")}\n</operator-guidance>`]
      : []),
    ...(examples && (examples.liked.length > 0 || examples.disliked.length > 0)
      ? [
        `<operator-liked-posts>\n${operatorExampleList(examples.liked)}\n</operator-liked-posts>`,
        `<operator-disliked-posts>\n${operatorExampleList(examples.disliked)}\n</operator-disliked-posts>`,
      ]
      : []),
    `job: ${args.context.job}`,
    `collectionStatus: ${args.context.collectionStatus ?? "unknown"}`,
    `marketBlind: ${args.context.marketBlind === true ? "true" : "false"}`,
    `statusQuoStages: ${stageList(args.context.statusQuoStages)}`,
    `<accepted-broadcast-history>\n${broadcastList(args.context.recentBroadcasts, "accepted")}\n</accepted-broadcast-history>`,
    `<staged-broadcast-history>\n${broadcastList(args.context.recentBroadcasts, "staged")}\n</staged-broadcast-history>`,
    `severity: ${args.item.severity}`,
    `auditClaim: ${claimLine(args.item.auditClaim)}`,
    `refs: ${args.item.refs.join(", ") || "(none)"}`,
    `<candidate-proposal untrusted="true">\n${candidateText}\n</candidate-proposal>`,
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
  guidance?: readonly string[]
  operatorExamples?: OperatorFeedbackExamples
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
        ...(args.guidance ? { guidance: args.guidance } : {}),
        ...(args.operatorExamples ? { operatorExamples: args.operatorExamples } : {}),
      }),
    })
    return validateWorthinessOutput(raw)
  } catch {
    return { ok: false, reason: "session-error" }
  }
}
