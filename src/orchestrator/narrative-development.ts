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

/** Lane filler that must not count as a catalyst name. */
const CATALYST_GENERIC = new Set([
  ...TOKEN_STOPWORDS,
  "stock", "tokens", "coins", "lane", "infra", "launch", "listed",
  "shipping", "early", "social", "volume", "liquidity", "timeline",
  "heat", "today", "team", "first", "pair", "pairs", "pool", "feed",
  "dev", "equity", "branch", "already", "mostly",
  "nft", "nfts", "defi", "dao", "usd", "usdc", "usdt",
  "api", "ceo", "tvl", "ath", "fdv", "mcap",
])

const NARRATIVE_CLAIM_TYPES: ReadonlySet<string> = new Set([
  "narrative-development",
  "narrative-emergence",
  "rotation",
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

/** Fold long.xyz and longdotxyz onto the same key. */
export function normalizeCatalystEntity(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^\$/u, "")
    .replace(/\./gu, "")
    .replace(/dot/gu, "")
}

/**
 * Distinctive names in broadcast copy: domains, tickers, and proper nouns.
 * Used to catch a rewrite of the same catalyst after wording changes.
 */
export function developmentCatalystEntities(text: string): Set<string> {
  const out = new Set<string>()
  const slice = text.slice(0, 560)
  const add = (raw: string): void => {
    const norm = normalizeCatalystEntity(raw)
    if (norm.length < 3) return
    if (CATALYST_GENERIC.has(norm)) return
    out.add(norm)
  }
  for (const match of slice.matchAll(/\b[a-z0-9]+(?:\.[a-z0-9]+)+\b/giu)) {
    add(match[0])
  }
  for (const match of slice.matchAll(/\b[a-z0-9]{2,}dot[a-z0-9]{2,}\b/giu)) {
    add(match[0])
  }
  for (const match of slice.matchAll(/\$[A-Za-z][A-Za-z0-9]{1,15}\b/gu)) {
    add(match[0])
  }
  for (const match of slice.matchAll(/\b[A-Z]{2,12}\b/gu)) {
    add(match[0])
  }
  for (const match of slice.matchAll(/\b[A-Z][a-z]+[A-Z][A-Za-z0-9]*\b/gu)) {
    add(match[0])
  }
  for (const match of slice.matchAll(/\b[A-Z][a-z]{2,20}\b/gu)) {
    add(match[0])
  }
  return out
}

/** True when incoming copy restates a prior name cluster with at most one new name. */
export function isSameCatalystRewrite(
  incomingText: string,
  priorSummary: string,
): boolean {
  const incoming = developmentCatalystEntities(incomingText)
  const prior = developmentCatalystEntities(priorSummary)
  if (incoming.size === 0 || prior.size === 0) return false
  const shared = [...incoming].filter((entity) => prior.has(entity))
  const fresh = [...incoming].filter((entity) => !prior.has(entity))
  return shared.length >= 2 && fresh.length < 2
}

export function repeatsRecentCatalyst(args: Readonly<{
  text: string
  subject: string
  recentClaims: readonly MarketClaimRecord[]
  nowIso: string
  narrativeKindsOnly?: boolean
}>): boolean {
  const subject = args.subject.trim().toLowerCase()
  for (const prior of args.recentClaims) {
    if (prior.subject.trim().toLowerCase() !== subject) continue
    if (!withinWindow(prior.occurredAt, args.nowIso, DEVELOPMENT_REPEAT_WINDOW_HOURS)) {
      continue
    }
    if (args.narrativeKindsOnly === true) {
      if (!prior.auditClaimType || !NARRATIVE_CLAIM_TYPES.has(prior.auditClaimType)) {
        continue
      }
    }
    if (isSameCatalystRewrite(args.text, prior.summary)) return true
  }
  return false
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

  if (repeatsRecentCatalyst({
    text: args.item.text,
    subject,
    recentClaims: args.recentClaims,
    nowIso: args.nowIso,
    narrativeKindsOnly: true,
  })) {
    return { ok: false, reason: "development-same-catalyst" }
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
