import type { BroadcastItem } from "../contracts/schemas.js"
import type { SocialEvidenceAssessment, SocialEvidenceReason } from "./social-evidence.js"

/**
 * Narrative claims need curated social evidence. This module turns one curated
 * assessment into a tier, and rejects narrative claim types below `strong`.
 * Token and wallet claims keep their existing market gates and pass through.
 */

export type NarrativeEvidenceTier = "strong" | "limited" | "none"

/** Stable reason slugs, ordered by report priority */
export type NarrativeEvidenceReason =
  | "no-eligible-posts"
  | "fresh-posts-below-floor"
  | "authors-below-floor"
  | "promotional-share-above-max"

export type NarrativeEvidenceThresholds = Readonly<{
  maxPromotionalShare: number
  minIndependentAuthors: number
  minFreshPosts: number
}>

export type NarrativeEvidenceQuality = Readonly<{
  schema: 1
  enabled: boolean
  tier: NarrativeEvidenceTier
  reasons: readonly NarrativeEvidenceReason[]
  freshPosts: number
  independentAuthors: number
  promotionalShare: number
  primarySourceAuthors: readonly string[]
  excludedCounts: Readonly<Record<SocialEvidenceReason, number>>
  thresholds: NarrativeEvidenceThresholds
}>

/** Claim types that must rest on curated social evidence */
export const NARRATIVE_CLAIM_TYPES: ReadonlySet<string> = Object.freeze(new Set([
  "narrative-emergence",
  "narrative-fade",
  "narrative-development",
  "rotation",
  "sentiment-collapse",
]))

/** Round to three decimals so the receipt stays byte-stable across runs */
function roundShare(value: number): number {
  return Math.round(value * 1_000) / 1_000
}

/**
 * Grade one curated assessment. `strong` needs enough fresh posts, enough
 * independent authors, and a promotional share at or below the maximum. A
 * primary-source handle is recorded as an extra signal only — it never replaces
 * the author floor.
 */
export function assessNarrativeEvidenceQuality(args: Readonly<{
  assessment: SocialEvidenceAssessment
  thresholds: NarrativeEvidenceThresholds
  enabled: boolean
}>): NarrativeEvidenceQuality {
  const { assessment, thresholds } = args
  const freshPosts = assessment.eligible.filter(
    (item) => item.freshnessTier === "live" || item.freshnessTier === "stale",
  ).length
  const independentAuthors = assessment.authors.length
  const promotionalShare = roundShare(assessment.promotionalShare)

  const reasons: NarrativeEvidenceReason[] = []
  if (freshPosts === 0) reasons.push("no-eligible-posts")
  else if (freshPosts < thresholds.minFreshPosts) reasons.push("fresh-posts-below-floor")
  if (independentAuthors < thresholds.minIndependentAuthors) {
    reasons.push("authors-below-floor")
  }
  if (promotionalShare > thresholds.maxPromotionalShare) {
    reasons.push("promotional-share-above-max")
  }

  const tier: NarrativeEvidenceTier = reasons.length === 0
    ? "strong"
    : freshPosts === 0
      ? "none"
      : "limited"

  return {
    schema: 1,
    enabled: args.enabled,
    tier,
    reasons,
    freshPosts,
    independentAuthors,
    promotionalShare,
    primarySourceAuthors: assessment.primarySourceAuthors,
    excludedCounts: assessment.excludedCounts,
    thresholds,
  }
}

export type NarrativeEvidenceGateResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: string }>

/**
 * Reject a narrative claim when the curated evidence is not `strong`. The
 * reject reason always names the first failing floor, so every rejection stays
 * deterministic and auditable.
 */
export function assertNarrativeEvidenceQuality(args: Readonly<{
  item: BroadcastItem
  quality?: NarrativeEvidenceQuality
}>): NarrativeEvidenceGateResult {
  const quality = args.quality
  if (!quality || !quality.enabled) return { ok: true }
  if (!NARRATIVE_CLAIM_TYPES.has(args.item.auditClaim.type)) return { ok: true }
  if (quality.tier === "strong") return { ok: true }
  const reason = quality.reasons[0] ?? "no-eligible-posts"
  return { ok: false, reason: `narrative-evidence-quality:${reason}` }
}
