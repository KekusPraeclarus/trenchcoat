import type { TrenchcoatConfig } from "../../lib/config.js"
import type { FetchLike } from "../market/geckoterminal.js"
import {
  fetchNeynarFeed,
  type FarcasterCast,
  type NeynarFeedKind,
} from "./neynar.js"

export type FarcasterScrapeTarget = Readonly<{
  kind: "for_you" | "channel" | "following"
  label: string
  channelId?: string
  feedKind: NeynarFeedKind
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
  skipAgent: boolean
}>

export type AssessedFarcasterBundle = Readonly<{
  assessment: FarcasterFeedAssessment
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
    return {
      target: bundle.target,
      casts: bundle.casts,
      eligibleCasts,
      counts,
      rejected: false,
      skipAgent: false,
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
    }
  }

  return {
    target: bundle.target,
    casts: bundle.casts,
    eligibleCasts: eligibleCasts.filter((cast) => (
      freshnessTierForAge(castAgeSec(fetchedAt, cast.timestamp)) !== "expired"
    )),
    counts,
    rejected: false,
    skipAgent: false,
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

  for (const target of resolveFarcasterTargets(config)) {
    const feed = await fetchNeynarFeed(fetcher, args.apiKey, target.feedKind, {
      fid: botFid,
      limit,
      ...(target.channelId ? { channelId: target.channelId } : {}),
    })
    const casts: FarcasterCast[] = []
    for (const cast of feed.casts) {
      if (seen.has(cast.hash)) continue
      seen.add(cast.hash)
      casts.push(cast)
    }
    assessed.push({
      assessment: assessFarcasterBundle({ target, casts }, fetchedAt),
    })
  }
  return assessed
}

export function summarizeFarcasterScrape(
  bundles: readonly AssessedFarcasterBundle[],
): unknown {
  return {
    targets: bundles.map((b) => ({
      label: b.assessment.target.label,
      kind: b.assessment.target.kind,
      counts: b.assessment.counts,
      rejected: b.assessment.rejected,
      ...(b.assessment.rejectReason ? { rejectReason: b.assessment.rejectReason } : {}),
      skipAgent: b.assessment.skipAgent,
    })),
    totalEligibleCasts: bundles.reduce((n, b) => n + b.assessment.eligibleCasts.length, 0),
  }
}

export function summarizeFarcasterAssessments(
  assessments: readonly FarcasterFeedAssessment[],
): string {
  return assessments.map((a) => (
    `${a.target.label}:live=${a.counts.live} stale=${a.counts.stale} expired=${a.counts.expired}`
    + (a.rejected ? ` rejected=${a.rejectReason}` : "")
  )).join(" ")
}
