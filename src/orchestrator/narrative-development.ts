/**
 * Host gate for `narrative-development` broadcasts: genuinely new updates inside
 * an existing narrative (product catalysts, new names entering a rotation) may
 * broadcast without a stage change, but must not repeat a recent development.
 */

import type { BroadcastItem } from "../contracts/schemas.js"
import type { NarrativeLogEntry } from "./narrative-log.js"
import type { MarketClaimRecord } from "./market-claims.js"

export const DEVELOPMENT_REPEAT_WINDOW_HOURS = 48

const TOKEN_STOPWORDS = new Set([
  "the", "and", "for", "with", "into", "from", "that", "this", "over",
  "still", "just", "now", "new", "news", "update", "meta", "meme", "chain",
  "coin", "token", "rotation", "narrative", "watch", "week", "next", "days",
])

/**
 * Salient tokens for novelty comparison: cashtags, all-caps ticker-ish tokens,
 * and lowercased words of 4+ chars minus stopwords. Pure tokenization — never
 * builds regexes from broadcast text.
 */
export function developmentSalientTokens(text: string): Set<string> {
  const out = new Set<string>()
  for (const match of text.slice(0, 560).matchAll(/\$?[A-Za-z0-9]{2,16}/gu)) {
    const raw = match[0]
    const bare = raw.startsWith("$") ? raw.slice(1) : raw
    const isTickerish = raw.startsWith("$") || (bare === bare.toUpperCase() && /[A-Z]/u.test(bare))
    const norm = bare.toLowerCase()
    if (TOKEN_STOPWORDS.has(norm)) continue
    if (isTickerish || norm.length >= 4) out.add(norm)
  }
  return out
}

function withinWindow(occurredAt: string, nowIso: string, hours: number): boolean {
  const at = Date.parse(occurredAt)
  const now = Date.parse(nowIso)
  if (!Number.isFinite(at) || !Number.isFinite(now)) return false
  return now - at <= hours * 3_600_000 && at <= now
}

/**
 * Allow a development only when its subject is a known narrative and its text
 * carries at least one salient token unseen in recent developments (and the
 * initial stage claim) on the same subject. Everything else is a repeat.
 */
export function assertNarrativeDevelopmentAllowed(args: Readonly<{
  item: BroadcastItem
  narrativeLog: readonly NarrativeLogEntry[]
  recentClaims: readonly MarketClaimRecord[]
  nowIso: string
  sameStageDevelopment?: boolean
}>): { ok: true } | { ok: false; reason: string } {
  const claim = args.item.auditClaim
  const isDevelopment = claim.type === "narrative-development"
    || args.sameStageDevelopment === true
  if (!isDevelopment) return { ok: true }

  const subject = claim.subject.trim().toLowerCase()
  const known = args.narrativeLog.some((entry) => entry.slug === subject)
  if (!known) {
    return { ok: false, reason: "development-unknown-narrative:use-narrative-emergence" }
  }

  const seen = new Set<string>()
  for (const prior of args.recentClaims) {
    if (prior.subject.trim().toLowerCase() !== subject) continue
    const narrativeKind = prior.auditClaimType === "narrative-development"
      || prior.auditClaimType === "narrative-emergence"
      || prior.auditClaimType === "rotation"
    if (!narrativeKind) continue
    if (!withinWindow(prior.occurredAt, args.nowIso, DEVELOPMENT_REPEAT_WINDOW_HOURS)) continue
    // 4-char stems so inflections (trade/trading, agent/agents) count as repeats
    for (const token of developmentSalientTokens(prior.summary)) seen.add(token.slice(0, 4))
  }

  const fresh = [...developmentSalientTokens(args.item.text)]
    .filter((t) => !seen.has(t.slice(0, 4)))
  if (fresh.length === 0) {
    return { ok: false, reason: "development-repeats-recent-broadcast" }
  }
  return { ok: true }
}
