/**
 * Channel distillers — host-side, fail-closed rewrites of a chat report into
 * per-destination payloads (INV-B2). Fixed host prompts, quoted untrusted input,
 * strict post-checks, never write state.
 *
 * Discord: run-scoped bottom-line, silent on unchanged-stage heat.
 * Telegram: longer landscape overview; restating current narratives is encouraged.
 */

import type { AuditClaim } from "../contracts/schemas.js"
import { hasLocalWorkspaceRefs } from "../lib/telegram-format.js"
import {
  DISCORD_DISTILLER_PROMPT,
  TELEGRAM_OVERVIEW_PROMPT,
} from "../prompts/host.js"
import {
  restatesUnchangedNarrativeStage,
  statusQuoFillerPattern,
  type StageKnown,
} from "./narrative-stage-dedupe.js"

export const DISCORD_TEXT_MAX = 320
export const DISCORD_TICKER_MAX = 3
export const TELEGRAM_TEXT_MAX = 8_000

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u
const PROVENANCE_HANDLE = /(?:twitter|farcaster):@[\w.-]+/iu
/** Bare @handle — excludes twitter:@ / farcaster:@ (colon precedes @) */
const BARE_AT_HANDLE = /(?<![a-z:])@[\w.-]+/iu
const TICKER_TOKEN = /\$[A-Za-z][A-Za-z0-9]{0,15}\b/gu

export type DistillSessionRunner = (
  args: Readonly<{ prompt: string; message: string }>,
) => Promise<string>

export type DistillArgs = Readonly<{
  reportText: string
  fallbackText: string
  auditClaim?: AuditClaim
  /** Narratives at unchanged heat — must not be restated at that stage (Discord) */
  unchangedStages?: readonly StageKnown[]
  dailyCap: number
  usedToday: number
  runSession?: DistillSessionRunner
  enabled?: boolean
}>

export type TelegramOverviewArgs = Readonly<{
  reportText: string
  fallbackText: string
  auditClaim?: AuditClaim
  /** Prior heat landscape — Telegram may restate these */
  knownStages?: readonly StageKnown[]
  dailyCap: number
  usedToday: number
  runSession?: DistillSessionRunner
  enabled?: boolean
}>

export type DistillResult = Readonly<{
  text: string
  usedFallback: boolean
  reason?: string
  used: number
  capExhausted: boolean
}>

function claimLine(auditClaim?: AuditClaim): string {
  return auditClaim
    ? `type=${auditClaim.type} subject=${auditClaim.subject} direction=${auditClaim.direction} horizonHours=${auditClaim.horizonHours}`
    : "type=unknown subject=unknown direction=unknown"
}

function stageList(stages: readonly StageKnown[] | undefined): string {
  const mapped = (stages ?? [])
    .slice(0, 24)
    .map((entry) => `${entry.slug}=${entry.stage}`)
    .join(", ")
  return mapped.length > 0 ? mapped : "(none)"
}

function stripFence(raw: string): string {
  let text = raw.trim()
  if (text.startsWith("```") && text.endsWith("```")) {
    text = text.replace(/^```(?:\w+)?\n?/u, "").replace(/\n?```$/u, "").trim()
  }
  return text
}

export function distillUserMessage(args: Readonly<{
  reportText: string
  auditClaim?: AuditClaim
  unchangedStages?: readonly StageKnown[]
}>): string {
  return [
    "Rewrite the quoted report as a single Discord bottom-line using the system rules.",
    `auditClaim (context only): ${claimLine(args.auditClaim)}`,
    `unchangedStages: ${stageList(args.unchangedStages)}`,
    "<untrusted-report>",
    args.reportText,
    "</untrusted-report>",
  ].join("\n")
}

export function telegramOverviewUserMessage(args: Readonly<{
  reportText: string
  auditClaim?: AuditClaim
  knownStages?: readonly StageKnown[]
}>): string {
  return [
    "Rewrite the quoted report as a Telegram landscape overview using the system rules.",
    `auditClaim: ${claimLine(args.auditClaim)}`,
    `knownStages: ${stageList(args.knownStages)}`,
    "<untrusted-report>",
    args.reportText,
    "</untrusted-report>",
  ].join("\n")
}

/** Mechanical Discord style post-check. Returns reason on reject. */
export function validateDiscordDistillOutput(
  raw: string,
  unchangedStages: readonly StageKnown[] = [],
): { ok: true; text: string } | { ok: false; reason: string } {
  const text = stripFence(raw)
  if (text.length < 1) return { ok: false, reason: "empty" }
  if ([...text].length > DISCORD_TEXT_MAX) return { ok: false, reason: "too-long" }
  if (CONTROL_CHARS.test(text)) return { ok: false, reason: "control-chars" }
  if (PROVENANCE_HANDLE.test(text)) return { ok: false, reason: "provenance-handle" }
  if (BARE_AT_HANDLE.test(text)) return { ok: false, reason: "bare-at-handle" }
  const tickers = text.match(TICKER_TOKEN) ?? []
  if (tickers.length > DISCORD_TICKER_MAX) return { ok: false, reason: "ticker-overflow" }
  if (statusQuoFillerPattern().test(text)) return { ok: false, reason: "status-quo-filler" }
  if (
    unchangedStages.length > 0
    && restatesUnchangedNarrativeStage(text, unchangedStages)
  ) {
    return { ok: false, reason: "unchanged-stage-restatement" }
  }
  return { ok: true, text }
}

/** Mechanical Telegram overview post-check. Restating known stages is allowed. */
export function validateTelegramOverviewOutput(
  raw: string,
): { ok: true; text: string } | { ok: false; reason: string } {
  const text = stripFence(raw)
  if (text.length < 1) return { ok: false, reason: "empty" }
  if ([...text].length > TELEGRAM_TEXT_MAX) return { ok: false, reason: "too-long" }
  if (CONTROL_CHARS.test(text)) return { ok: false, reason: "control-chars" }
  if (PROVENANCE_HANDLE.test(text)) return { ok: false, reason: "provenance-handle" }
  if (BARE_AT_HANDLE.test(text)) return { ok: false, reason: "bare-at-handle" }
  if (hasLocalWorkspaceRefs(text)) return { ok: false, reason: "workspace-path" }
  return { ok: true, text }
}

/**
 * Compress a chat report into a Discord bottom-line. Fail-closed to fallbackText
 * on any miss: disabled, missing runner, cap exhausted, session error, or
 * post-check reject. Host attaches at most one Discord payload per run.
 */
export async function runDiscordDistiller(args: DistillArgs): Promise<DistillResult> {
  const fallback = (reason: string, used: number, capExhausted = false): DistillResult => ({
    text: args.fallbackText,
    usedFallback: true,
    reason,
    used,
    capExhausted,
  })

  if (args.enabled === false) {
    return fallback("disabled", args.usedToday)
  }
  if (args.usedToday >= args.dailyCap) {
    return fallback("cap-exhausted", args.usedToday, true)
  }
  if (!args.runSession) {
    return fallback("no-runner", args.usedToday)
  }

  const used = args.usedToday + 1
  const unchanged = args.unchangedStages ?? []
  try {
    const raw = await args.runSession({
      prompt: DISCORD_DISTILLER_PROMPT,
      message: distillUserMessage({
        reportText: args.reportText,
        ...(args.auditClaim ? { auditClaim: args.auditClaim } : {}),
        ...(unchanged.length > 0 ? { unchangedStages: unchanged } : {}),
      }),
    })
    const checked = validateDiscordDistillOutput(raw, unchanged)
    if (!checked.ok) return fallback(checked.reason, used)
    return { text: checked.text, usedFallback: false, used, capExhausted: false }
  } catch {
    return fallback("session-error", used)
  }
}

/**
 * Rewrite a chat report into a Telegram landscape overview. Fail-closed to
 * fallbackText on any miss. May restate knownStages heat.
 */
export async function runTelegramOverviewDistiller(
  args: TelegramOverviewArgs,
): Promise<DistillResult> {
  const fallback = (reason: string, used: number, capExhausted = false): DistillResult => ({
    text: args.fallbackText,
    usedFallback: true,
    reason,
    used,
    capExhausted,
  })

  if (args.enabled === false) {
    return fallback("disabled", args.usedToday)
  }
  if (args.usedToday >= args.dailyCap) {
    return fallback("cap-exhausted", args.usedToday, true)
  }
  if (!args.runSession) {
    return fallback("no-runner", args.usedToday)
  }

  const used = args.usedToday + 1
  const known = args.knownStages ?? []
  try {
    const raw = await args.runSession({
      prompt: TELEGRAM_OVERVIEW_PROMPT,
      message: telegramOverviewUserMessage({
        reportText: args.reportText,
        ...(args.auditClaim ? { auditClaim: args.auditClaim } : {}),
        ...(known.length > 0 ? { knownStages: known } : {}),
      }),
    })
    const checked = validateTelegramOverviewOutput(raw)
    if (!checked.ok) return fallback(checked.reason, used)
    return { text: checked.text, usedFallback: false, used, capExhausted: false }
  } catch {
    return fallback("session-error", used)
  }
}
