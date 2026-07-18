import type { CanonicalIdentity } from "../../contracts/schemas.js"
import type { FarcasterCast } from "./neynar.js"
import { searchCasts } from "./neynar.js"
import type { FetchLike } from "../market/geckoterminal.js"

export type ResearchFarcasterQuery = Readonly<{
  kind: "token-address" | "symbol-chain"
  query: string
  label: string
}>

/** Host-built search queries only — never derived from cast text */
export function buildResearchFarcasterQueries(
  identity: CanonicalIdentity,
): readonly ResearchFarcasterQuery[] {
  const queries: ResearchFarcasterQuery[] = [
    {
      kind: "token-address",
      query: identity.tokenAddress,
      label: "token-address",
    },
  ]
  const symbol = identity.symbolDisplay.trim()
  if (symbol.length >= 2 && symbol.length <= 32 && /^[A-Za-z0-9.$]+$/u.test(symbol)) {
    queries.push({
      kind: "symbol-chain",
      query: `${symbol} ${identity.chain}`,
      label: "symbol-chain",
    })
  }
  return queries
}

export type FarcasterPopularitySummary = Readonly<{
  status: "ok" | "degraded" | "unavailable"
  reason?: string
  castCount: number
  uniqueAuthors: number
  recentCastCount: number
  recentWindowHours: number
  queriesAttempted: number
  queriesSucceeded: number
  engagement: Readonly<{
    castsWithLikes: number
    totalLikesKnown: number
    totalRecastsKnown: number
    totalRepliesKnown: number
    medianLikesKnown: number | null
  }>
  sampleNote: string
}>

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
  }
  return sorted[mid]!
}

export function summarizeFarcasterPopularity(args: Readonly<{
  casts: readonly FarcasterCast[]
  fetchedAt: string
  recentWindowHours?: number
  queriesAttempted: number
  queriesSucceeded: number
  unavailableReason?: string
}>): FarcasterPopularitySummary {
  const windowHours = args.recentWindowHours ?? 48
  if (args.unavailableReason) {
    return {
      status: "unavailable",
      reason: args.unavailableReason,
      castCount: 0,
      uniqueAuthors: 0,
      recentCastCount: 0,
      recentWindowHours: windowHours,
      queriesAttempted: args.queriesAttempted,
      queriesSucceeded: args.queriesSucceeded,
      engagement: {
        castsWithLikes: 0,
        totalLikesKnown: 0,
        totalRecastsKnown: 0,
        totalRepliesKnown: 0,
        medianLikesKnown: null,
      },
      sampleNote: "Farcaster sample unavailable — do not invent sentiment or popularity",
    }
  }

  const fetchedMs = Date.parse(args.fetchedAt)
  const recentCutoff = fetchedMs - windowHours * 3_600_000
  const authors = new Set(args.casts.map((c) => c.author.toLowerCase()))
  const recent = args.casts.filter((c) => {
    const ts = Date.parse(c.timestamp)
    return Number.isFinite(ts) && ts >= recentCutoff
  })
  const likes = args.casts
    .map((c) => c.engagement.likes)
    .filter((n): n is number => typeof n === "number")
  const recasts = args.casts
    .map((c) => c.engagement.recasts)
    .filter((n): n is number => typeof n === "number")
  const replies = args.casts
    .map((c) => c.engagement.replies)
    .filter((n): n is number => typeof n === "number")

  const degraded = args.queriesSucceeded < args.queriesAttempted
  return {
    status: degraded ? "degraded" : "ok",
    ...(degraded ? { reason: "one or more search queries failed" } : {}),
    castCount: args.casts.length,
    uniqueAuthors: authors.size,
    recentCastCount: recent.length,
    recentWindowHours: windowHours,
    queriesAttempted: args.queriesAttempted,
    queriesSucceeded: args.queriesSucceeded,
    engagement: {
      castsWithLikes: likes.length,
      totalLikesKnown: likes.reduce((a, b) => a + b, 0),
      totalRecastsKnown: recasts.reduce((a, b) => a + b, 0),
      totalRepliesKnown: replies.reduce((a, b) => a + b, 0),
      medianLikesKnown: median(likes),
    },
    sampleNote: [
      "Sample is bounded host Farcaster search only — not protocol-wide reach.",
      "Missing engagement metrics are unknown, not zero.",
      "Sentiment is model-judged from untrusted cast text with sample-size caveats.",
    ].join(" "),
  }
}

export type ResearchFarcasterResult = Readonly<{
  casts: readonly FarcasterCast[]
  popularity: FarcasterPopularitySummary
}>

export async function searchResearchTokenFarcaster(args: Readonly<{
  identity: CanonicalIdentity
  apiKey: string
  maxCasts: number
  fetchedAt: string
  recentWindowHours?: number
  fetcher?: FetchLike
}>): Promise<ResearchFarcasterResult> {
  const fetcher = args.fetcher ?? fetch
  const queries = buildResearchFarcasterQueries(args.identity)
  const seen = new Set<string>()
  const casts: FarcasterCast[] = []
  let succeeded = 0

  for (const query of queries) {
    try {
      const feed = await searchCasts(fetcher, args.apiKey, query.query, {
        limit: Math.min(args.maxCasts, 50),
      })
      succeeded += 1
      for (const cast of feed.casts) {
        if (seen.has(cast.hash)) continue
        seen.add(cast.hash)
        casts.push(cast)
        if (casts.length >= args.maxCasts) break
      }
    } catch {
      // counted as failed query; popularity marks degraded
    }
    if (casts.length >= args.maxCasts) break
  }

  return {
    casts: casts.slice(0, args.maxCasts),
    popularity: summarizeFarcasterPopularity({
      casts,
      fetchedAt: args.fetchedAt,
      ...(args.recentWindowHours !== undefined
        ? { recentWindowHours: args.recentWindowHours }
        : {}),
      queriesAttempted: queries.length,
      queriesSucceeded: succeeded,
    }),
  }
}
