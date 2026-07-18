/**
 * Discord distiller — host-side, fail-closed compression of a chat report into a
 * short actionable Discord payload (INV-B2). Mirrors intent-session: fixed host
 * prompt, quoted untrusted input, strict post-checks, never writes state.
 */

import type { AuditClaim } from "../contracts/schemas.js"
import { DISCORD_DISTILLER_PROMPT } from "../prompts/host.js"

export const DISCORD_TEXT_MAX = 1_000
export const DISCORD_TICKER_MAX = 3

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u
const PROVENANCE_HANDLE = /(?:twitter|farcaster):@[\w.-]+/iu
const TICKER_TOKEN = /\$[A-Za-z][A-Za-z0-9]{0,15}\b/gu
const STATUS_QUO_FILLER = /\b(?:still have|continues to|under that)\b|\bremains\b/iu

export type DistillSessionRunner = (
  args: Readonly<{ prompt: string; message: string }>,
) => Promise<string>

export type DistillArgs = Readonly<{
  reportText: string
  fallbackText: string
  auditClaim?: AuditClaim
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

export function distillUserMessage(args: Readonly<{
  reportText: string
  auditClaim?: AuditClaim
}>): string {
  const claim = args.auditClaim
    ? `type=${args.auditClaim.type} subject=${args.auditClaim.subject} direction=${args.auditClaim.direction} horizonHours=${args.auditClaim.horizonHours}`
    : "type=unknown subject=unknown direction=unknown"
  return [
    "Rewrite the quoted report for Discord using the system rules.",
    `auditClaim: ${claim}`,
    "<untrusted-report>",
    args.reportText,
    "</untrusted-report>",
  ].join("\n")
}

/** Mechanical Discord style post-check. Returns reason on reject. */
export function validateDiscordDistillOutput(raw: string): { ok: true; text: string } | { ok: false; reason: string } {
  let text = raw.trim()
  if (text.startsWith("```") && text.endsWith("```")) {
    text = text.replace(/^```(?:\w+)?\n?/u, "").replace(/\n?```$/u, "").trim()
  }
  if (text.length < 1) return { ok: false, reason: "empty" }
  if ([...text].length > DISCORD_TEXT_MAX) return { ok: false, reason: "too-long" }
  if (CONTROL_CHARS.test(text)) return { ok: false, reason: "control-chars" }
  if (PROVENANCE_HANDLE.test(text)) return { ok: false, reason: "provenance-handle" }
  const tickers = text.match(TICKER_TOKEN) ?? []
  if (tickers.length > DISCORD_TICKER_MAX) return { ok: false, reason: "ticker-overflow" }
  if (STATUS_QUO_FILLER.test(text)) return { ok: false, reason: "status-quo-filler" }
  return { ok: true, text }
}

/**
 * Compress a chat report for Discord. Fail-closed to fallbackText on any miss:
 * disabled, missing runner, cap exhausted, session error, or post-check reject.
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
  try {
    const raw = await args.runSession({
      prompt: DISCORD_DISTILLER_PROMPT,
      message: distillUserMessage({
        reportText: args.reportText,
        ...(args.auditClaim ? { auditClaim: args.auditClaim } : {}),
      }),
    })
    const checked = validateDiscordDistillOutput(raw)
    if (!checked.ok) return fallback(checked.reason, used)
    return { text: checked.text, usedFallback: false, used, capExhausted: false }
  } catch {
    return fallback("session-error", used)
  }
}
