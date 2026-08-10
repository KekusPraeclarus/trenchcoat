import { createHash } from "node:crypto"
import type { SnapshotEnvelope } from "../contracts/schemas.js"

/**
 * Host-side curation of social snapshot items before the narrative agent reads
 * them. The archive keeps every raw collector file; this module only shapes the
 * derived `narrative-social-*` snapshots and the quality receipt beside them.
 */

type SnapshotItem = SnapshotEnvelope["items"][number]

/** Why one item left the derived narrative evidence set */
export type SocialEvidenceReason =
  | "collector-status"
  | "duplicate"
  | "repeated-promotion"
  | "promotion-pattern"
  | "expired"

export type SocialEvidenceExclusion = Readonly<{
  provenance: string
  reason: SocialEvidenceReason
}>

export type SocialEvidenceAssessment = Readonly<{
  /** Items the agent may cite for a narrative claim */
  eligible: readonly SnapshotItem[]
  excluded: readonly SocialEvidenceExclusion[]
  excludedCounts: Readonly<Record<SocialEvidenceReason, number>>
  /** Distinct authors behind the eligible items, lowercase and sorted */
  authors: readonly string[]
  /** Eligible authors that the operator marked as a primary source */
  primarySourceAuthors: readonly string[]
  /** Promotional share of the deduplicated candidate set, 0 when empty */
  promotionalShare: number
  /** Distinct normalized topic keys across the eligible items */
  topicKeys: readonly string[]
  counts: Readonly<{ input: number; candidates: number; eligible: number; promotional: number }>
}>

/** Host status and receipt lines that must never count as social evidence */
const STATUS_PROVENANCE = /:(?:narrative-status|market-blind|collection-status|status):/u
const STATUS_TEXT = /^(?:[a-zA-Z][a-zA-Z0-9]*=)/u
const STATUS_KEY_TEXT =
  /^(?:marketBlind|listScan|farcasterScan|fomoNarrativeScan|usableEvidence|marketSource|kind)=/u

const PROMOTIONAL_PHRASES: readonly RegExp[] = Object.freeze([
  /\bpresale\b/iu,
  /\bwhitelist\b/iu,
  /\bairdrop\b/iu,
  /\bgiveaway\b/iu,
  /\bfree\s+mint\b/iu,
  /\bbuy\s+(?:now|the\s+dip)\b/iu,
  /\bape\s+in\b/iu,
  /\bdon'?t\s+miss\b/iu,
  /\blast\s+chance\b/iu,
  /\bguaranteed\b/iu,
  /\bnext\s+\d+\s*x\b/iu,
  /\b\d{2,}\s*x\b/u,
  /\bpump\b/iu,
  /\bdegen\s+play\b/iu,
  /\bjoin\s+(?:my|our|the)\b/iu,
  /\bt\.me\//iu,
  /\bref(?:erral)?\s*(?:code|link)\b/iu,
])

const CASHTAG = /\$[A-Za-z][A-Za-z0-9]{1,9}/gu
const HASHTAG = /#[A-Za-z][A-Za-z0-9_]{1,30}/gu
const STOP_WORDS: ReadonlySet<string> = Object.freeze(new Set([
  "about", "after", "again", "against", "another", "because", "before", "being",
  "between", "could", "every", "first", "from", "going", "have", "here", "into",
  "just", "like", "look", "make", "more", "most", "much", "need", "never",
  "only", "other", "over", "same", "should", "since", "some", "still", "such",
  "than", "that", "their", "them", "then", "there", "these", "they", "thing",
  "think", "this", "those", "time", "very", "well", "were", "what", "when",
  "where", "which", "while", "will", "with", "would", "your",
]))

/**
 * Author handle behind one item, lowercase and without the leading `@`.
 * Provenance shapes: `twitter:@handle`, `farcaster:@handle`, `<runId>:tweet:<id>`.
 * Returns undefined when the collector kept no author, so the caller can treat
 * the item as its own anonymous author.
 */
export function authorFromProvenance(provenance: string): string | undefined {
  const match = /^(twitter|farcaster|x|telegram|discord):@?([A-Za-z0-9_.-]{1,64})/u
    .exec(provenance.trim())
  const platform = match?.[1]
  const handle = match?.[2]
  if (!platform || !handle) return undefined
  return `${platform.toLowerCase()}:${handle.toLowerCase()}`
}

/** Normalized topic keys — cashtags, hashtags, then long content words */
export function topicKeysFromItem(item: Readonly<{ text: string }>): readonly string[] {
  const keys = new Set<string>()
  for (const tag of item.text.match(CASHTAG) ?? []) keys.add(tag.slice(1).toLowerCase())
  for (const tag of item.text.match(HASHTAG) ?? []) keys.add(tag.slice(1).toLowerCase())
  for (const word of item.text.toLowerCase().match(/[a-z][a-z0-9-]{3,}/gu) ?? []) {
    if (STOP_WORDS.has(word)) continue
    keys.add(word)
  }
  return [...keys].sort()
}

/**
 * Balanced promotional heuristic: an explicit sales phrase, or dense ticker and
 * hashtag spam. Deterministic and text-only — no model call.
 */
export function looksPromotional(text: string): boolean {
  for (const pattern of PROMOTIONAL_PHRASES) {
    if (pattern.test(text)) return true
  }
  const cashtags = text.match(CASHTAG)?.length ?? 0
  const hashtags = text.match(HASHTAG)?.length ?? 0
  if (cashtags >= 4) return true
  if (hashtags >= 4) return true
  if (cashtags >= 2 && hashtags >= 2) return true
  return false
}

function normalizedTextHash(text: string): string {
  const normalized = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/gu, " ")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32)
}

function isCollectorStatus(item: SnapshotItem): boolean {
  if (STATUS_PROVENANCE.test(item.provenance)) return true
  if (item.provenance.startsWith("host.")) return true
  if (STATUS_TEXT.test(item.text) && !item.text.includes(" ")) return true
  return STATUS_KEY_TEXT.test(item.text)
}

const EMPTY_COUNTS: Readonly<Record<SocialEvidenceReason, number>> = Object.freeze({
  "collector-status": 0,
  duplicate: 0,
  "repeated-promotion": 0,
  "promotion-pattern": 0,
  expired: 0,
})

/**
 * Curate one social snapshot set. Order matters: status lines and expired posts
 * leave first, then duplicates, then promotion. The promotional share measures
 * the deduplicated candidate set, so heavy promotion still lowers the share even
 * though the promotional items themselves never reach the agent.
 */
export function curateSocialEvidence(args: Readonly<{
  items: readonly SnapshotItem[]
  primarySourceHandles?: readonly string[]
}>): SocialEvidenceAssessment {
  const primary = new Set(
    (args.primarySourceHandles ?? []).map((handle) =>
      handle.trim().toLowerCase().replace(/^@/u, "")
    ),
  )
  const excluded: SocialEvidenceExclusion[] = []
  const counts: Record<SocialEvidenceReason, number> = { ...EMPTY_COUNTS }
  const drop = (item: SnapshotItem, reason: SocialEvidenceReason): void => {
    excluded.push({ provenance: item.provenance, reason })
    counts[reason] += 1
  }

  const candidates: SnapshotItem[] = []
  const seen = new Set<string>()
  for (const item of args.items) {
    if (isCollectorStatus(item)) {
      drop(item, "collector-status")
      continue
    }
    if (item.freshnessTier === "expired") {
      drop(item, "expired")
      continue
    }
    const keys = [
      ...(item.dedupeKey ? [`dedupe:${item.dedupeKey}`] : []),
      ...(item.url ? [`url:${item.url}`] : []),
      `text:${normalizedTextHash(item.text)}`,
    ]
    if (keys.some((key) => seen.has(key))) {
      drop(item, "duplicate")
      continue
    }
    for (const key of keys) seen.add(key)
    candidates.push(item)
  }

  const eligible: SnapshotItem[] = []
  const authors = new Set<string>()
  const primarySourceAuthors = new Set<string>()
  const promotionalAuthors = new Set<string>()
  let promotional = 0
  for (const [index, item] of candidates.entries()) {
    const author = authorFromProvenance(item.provenance) ?? `anon:${index}`
    if (looksPromotional(item.text)) {
      promotional += 1
      drop(item, promotionalAuthors.has(author) ? "repeated-promotion" : "promotion-pattern")
      promotionalAuthors.add(author)
      continue
    }
    eligible.push(item)
    authors.add(author)
    const handle = author.split(":")[1]
    if (handle && primary.has(handle)) primarySourceAuthors.add(author)
  }

  const topicKeys = new Set<string>()
  for (const item of eligible) {
    for (const key of topicKeysFromItem(item)) topicKeys.add(key)
  }

  return {
    eligible,
    excluded,
    excludedCounts: counts,
    authors: [...authors].sort(),
    primarySourceAuthors: [...primarySourceAuthors].sort(),
    promotionalShare: candidates.length === 0 ? 0 : promotional / candidates.length,
    topicKeys: [...topicKeys].sort(),
    counts: {
      input: args.items.length,
      candidates: candidates.length,
      eligible: eligible.length,
      promotional,
    },
  }
}
