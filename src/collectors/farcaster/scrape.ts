import type { TrenchcoatConfig } from "../../lib/config.js"
import type { FetchLike } from "../market/geckoterminal.js"
import {
  fetchNeynarFeed,
  fetchNeynarTrendingFallback,
  type FarcasterCast,
  type NeynarFeedKind,
} from "./neynar.js"

export type FarcasterScrapeTarget = Readonly<{
  kind: "for_you" | "channel" | "following" | "trending"
  label: string
  channelId?: string
  feedKind: NeynarFeedKind
  /** Present when this feed was fetched as a bounded For You recovery */
  fallbackOf?: "for_you"
}>

export type FarcasterScrapeBundle = Readonly<{
  target: FarcasterScrapeTarget
  casts: readonly FarcasterCast[]
}>

export type FarcasterFreshnessTier = "live" | "stale" | "expired"

export const FARCASTER_LIVE_MAX_SEC = 6 * 3_600
export const FARCASTER_STALE_MAX_SEC = 24 * 3_600

export type FarcasterFeedAssessment = Readonly<{
  target: FarcasterScrapeTarget
  casts: readonly FarcasterCast[]
  eligibleCasts: readonly FarcasterCast[]
  counts: Readonly<{
    total: number
    live: number
    stale: number
    expired: number
  }>
  rejected: boolean
  rejectReason?: string
  /** Per-feed legacy flag: For You alone would leave analysis empty */
  skipAgent: boolean
  analysisEligible: boolean
  engagementEligible: boolean
}>

export type AssessedFarcasterBundle = Readonly<{
  assessment: FarcasterFeedAssessment
}>

export type FarcasterFeedReceipt = Readonly<{
  label: string
  kind: FarcasterScrapeTarget["kind"]
  counts: FarcasterFeedAssessment["counts"]
  rejected: boolean
  rejectReason?: string
  fallbackOf?: "for_you"
  usableEvidence: number
  analysisEligible: boolean
  engagementEligible: boolean
}>

export type FarcasterCollectionReceipt = Readonly<{
  schema: 1
  feeds: readonly FarcasterFeedReceipt[]
  fallbackUsed: boolean
  usableEvidenceCount: number
  engagementDisabled: boolean
  skipAgent: boolean
}>

export function resolveFarcasterTargets(config: TrenchcoatConfig): FarcasterScrapeTarget[] {
  const targets: FarcasterScrapeTarget[] = []
  if (config.farcaster.scrape_for_you) {
    targets.push({
      kind: "for_you",
      label: "for-you",
      feedKind: "for_you",
    })
  }
  const channels = config.farcaster.operator_channel_ids
  if (channels) {
    targets.push({
      kind: "channel",
      label: "operator-channel-1",
      channelId: channels[0],
      feedKind: "channel",
    })
    targets.push({
      kind: "channel",
      label: "operator-channel-2",
      channelId: channels[1],
      feedKind: "channel",
    })
  }
  if (config.farcaster.bot_fid !== undefined) {
    targets.push({
      kind: "following",
      label: "following",
      feedKind: "following",
    })
  }
  return targets
}

export function castAgeSec(fetchedAt: string, castTimestamp: string): number {
  const fetchedMs = Date.parse(fetchedAt)
  const castMs = Date.parse(castTimestamp)
  if (!Number.isFinite(fetchedMs) || !Number.isFinite(castMs)) return Number.POSITIVE_INFINITY
  const ageSec = Math.floor((fetchedMs - castMs) / 1_000)
  // Future-dated casts are clock noise (audit A4 2061/2076 timestamps) — treat as expired
  if (ageSec < 0) return Number.POSITIVE_INFINITY
  return ageSec
}

export function freshnessTierForAge(ageSec: number): FarcasterFreshnessTier {
  if (ageSec <= FARCASTER_LIVE_MAX_SEC) return "live"
  if (ageSec <= FARCASTER_STALE_MAX_SEC) return "stale"
  return "expired"
}

export function detectRepeatedTwoHashStalePattern(
  casts: readonly FarcasterCast[],
  fetchedAt: string,
): boolean {
  if (casts.length < 2) return false
  const unique = new Set(casts.map((cast) => cast.hash.toLowerCase()))
  if (unique.size !== 2) return false
  return casts.every((cast) => freshnessTierForAge(castAgeSec(fetchedAt, cast.timestamp)) !== "live")
}

function forYouNeedsTrendingFallback(assessment: FarcasterFeedAssessment): boolean {
  if (assessment.target.kind !== "for_you" || !assessment.rejected) return false
  return assessment.rejectReason === "no_live_casts"
    || assessment.rejectReason === "repeated_two_hash_stale"
}

export function assessFarcasterBundle(
  bundle: FarcasterScrapeBundle,
  fetchedAt: string,
): FarcasterFeedAssessment {
  const counts = { total: bundle.casts.length, live: 0, stale: 0, expired: 0 }
  const eligibleCasts: FarcasterCast[] = []
  for (const cast of bundle.casts) {
    const tier = freshnessTierForAge(castAgeSec(fetchedAt, cast.timestamp))
    counts[tier] += 1
    if (tier !== "expired") eligibleCasts.push(cast)
  }

  if (bundle.target.kind !== "for_you") {
    const analysisEligible = eligibleCasts.length > 0
    return {
      target: bundle.target,
      casts: bundle.casts,
      eligibleCasts,
      counts,
      rejected: false,
      skipAgent: !analysisEligible,
      analysisEligible,
      engagementEligible: false,
    }
  }

  if (detectRepeatedTwoHashStalePattern(bundle.casts, fetchedAt)) {
    return {
      target: bundle.target,
      casts: bundle.casts,
      eligibleCasts: [],
      counts,
      rejected: true,
      rejectReason: "repeated_two_hash_stale",
      skipAgent: true,
      analysisEligible: false,
      engagementEligible: false,
    }
  }

  if (counts.live === 0) {
    return {
      target: bundle.target,
      casts: bundle.casts,
      eligibleCasts: [],
      counts,
      rejected: true,
      rejectReason: "no_live_casts",
      skipAgent: true,
      analysisEligible: false,
      engagementEligible: false,
    }
  }

  const liveEligible = eligibleCasts.filter((cast) => (
    freshnessTierForAge(castAgeSec(fetchedAt, cast.timestamp)) === "live"
  ))
  return {
    target: bundle.target,
    casts: bundle.casts,
    eligibleCasts: eligibleCasts.filter((cast) => (
      freshnessTierForAge(castAgeSec(fetchedAt, cast.timestamp)) !== "expired"
    )),
    counts,
    rejected: false,
    skipAgent: false,
    analysisEligible: liveEligible.length > 0,
    engagementEligible: liveEligible.length > 0,
  }
}

export function buildFarcasterCollectionReceipt(
  assessments: readonly FarcasterFeedAssessment[],
): FarcasterCollectionReceipt {
  const feeds: FarcasterFeedReceipt[] = assessments.map((a) => ({
    label: a.target.label,
    kind: a.target.kind,
    counts: a.counts,
    rejected: a.rejected,
    ...(a.rejectReason ? { rejectReason: a.rejectReason } : {}),
    ...(a.target.fallbackOf ? { fallbackOf: a.target.fallbackOf } : {}),
    usableEvidence: a.eligibleCasts.length,
    analysisEligible: a.analysisEligible,
    engagementEligible: a.engagementEligible,
  }))
  const usableEvidenceCount = feeds.reduce((n, f) => n + f.usableEvidence, 0)
  const analysisOk = assessments.some((a) => a.analysisEligible)
  const engagementOk = assessments.some((a) => a.engagementEligible)
  return {
    schema: 1,
    feeds,
    fallbackUsed: assessments.some((a) => a.target.fallbackOf === "for_you"),
    usableEvidenceCount,
    engagementDisabled: !engagementOk,
    skipAgent: !analysisOk,
  }
}

export async function scrapeConfiguredFarcaster(
  config: TrenchcoatConfig,
  args: Readonly<{
    apiKey: string
    fetcher?: FetchLike
    fetchedAt?: string
  }>,
): Promise<AssessedFarcasterBundle[]> {
  if (!config.farcaster.enabled) return []
  const botFid = config.farcaster.bot_fid
  if (botFid === undefined) {
    throw new Error("farcaster.bot_fid is required when farcaster.enabled")
  }
  const fetcher = args.fetcher ?? fetch
  const fetchedAt = args.fetchedAt ?? new Date().toISOString()
  const limit = config.farcaster.max_items_per_feed
  const seen = new Set<string>()
  const assessed: AssessedFarcasterBundle[] = []

  const takeUnique = (casts: readonly FarcasterCast[]): FarcasterCast[] => {
    const out: FarcasterCast[] = []
    for (const cast of casts) {
      if (seen.has(cast.hash)) continue
      seen.add(cast.hash)
      out.push(cast)
    }
    return out
  }

  for (const target of resolveFarcasterTargets(config)) {
    const feed = await fetchNeynarFeed(fetcher, args.apiKey, target.feedKind, {
      fid: botFid,
      limit,
      ...(target.channelId ? { channelId: target.channelId } : {}),
    })
    const assessment = assessFarcasterBundle(
      { target, casts: takeUnique(feed.casts) },
      fetchedAt,
    )
    assessed.push({ assessment })

    // One rate-gated trending recovery when For You has no live evidence — no cursors/cache-bust
    if (forYouNeedsTrendingFallback(assessment)) {
      const trending = await fetchNeynarTrendingFallback(fetcher, args.apiKey, { limit })
      const fallbackTarget: FarcasterScrapeTarget = {
        kind: "trending",
        label: "trending-fallback",
        feedKind: "trending",
        fallbackOf: "for_you",
      }
      assessed.push({
        assessment: assessFarcasterBundle(
          { target: fallbackTarget, casts: takeUnique(trending.casts) },
          fetchedAt,
        ),
      })
    }
  }
  return assessed
}

export function summarizeFarcasterScrape(
  bundles: readonly AssessedFarcasterBundle[],
): unknown {
  const receipt = buildFarcasterCollectionReceipt(bundles.map((b) => b.assessment))
  return receipt
}

export function summarizeFarcasterAssessments(
  assessments: readonly FarcasterFeedAssessment[],
): string {
  return assessments.map((a) => (
    `${a.target.label}:live=${a.counts.live} stale=${a.counts.stale} expired=${a.counts.expired}`
    + (a.rejected ? ` rejected=${a.rejectReason}` : "")
    + (a.target.fallbackOf ? " fallback=for_you" : "")
  )).join(" ")
}
