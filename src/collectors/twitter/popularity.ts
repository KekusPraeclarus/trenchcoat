import type { CanonicalIdentity } from "../../contracts/schemas.js"
import type { TwitterPost } from "./session.js"

export type ResearchTwitterQuery = Readonly<{
  kind: "token-address" | "symbol-cashtag" | "symbol-chain"
  query: string
  label: string
}>

/** Host-built search queries only — never derived from tweet text */
export function buildResearchTwitterQueries(
  identity: CanonicalIdentity,
): readonly ResearchTwitterQuery[] {
  const queries: ResearchTwitterQuery[] = [
    {
      kind: "token-address",
      query: identity.tokenAddress,
      label: "token-address",
    },
  ]
  const symbol = identity.symbolDisplay.trim().replace(/^\$/u, "")
  if (symbol.length >= 2 && symbol.length <= 32 && /^[A-Za-z0-9.]+$/u.test(symbol)) {
    queries.push({
      kind: "symbol-cashtag",
      query: `$${symbol}`,
      label: "symbol-cashtag",
    })
    queries.push({
      kind: "symbol-chain",
      query: `${symbol} ${identity.chain}`,
      label: "symbol-chain",
    })
  }
  return queries
}

export function twitterSearchUrl(
  query: string,
  tab: "live" | "top" = "live",
): string {
  const encoded = encodeURIComponent(query)
  // Latest first for sentiment recency; Top is a host fallback when Latest is empty
  if (tab === "top") return `https://x.com/search?q=${encoded}&src=typed_query`
  return `https://x.com/search?q=${encoded}&src=typed_query&f=live`
}

export type TwitterPopularitySummary = Readonly<{
  status: "ok" | "degraded" | "unavailable"
  reason?: string
  postCount: number
  uniqueAuthors: number
  recentPostCount: number
  recentWindowHours: number
  queriesAttempted: number
  queriesSucceeded: number
  challenged: boolean
  engagement: Readonly<{
    postsWithLikes: number
    postsWithViews: number
    totalLikesKnown: number
    totalViewsKnown: number
    totalRepliesKnown: number
    totalRepostsKnown: number
    medianLikesKnown: number | null
    medianViewsKnown: number | null
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

export function summarizeTwitterPopularity(args: Readonly<{
  posts: readonly TwitterPost[]
  fetchedAt: string
  recentWindowHours?: number
  queriesAttempted: number
  queriesSucceeded: number
  challenged: boolean
  unavailableReason?: string
}>): TwitterPopularitySummary {
  const windowHours = args.recentWindowHours ?? 48
  if (args.unavailableReason) {
    return {
      status: "unavailable",
      reason: args.unavailableReason,
      postCount: 0,
      uniqueAuthors: 0,
      recentPostCount: 0,
      recentWindowHours: windowHours,
      queriesAttempted: args.queriesAttempted,
      queriesSucceeded: args.queriesSucceeded,
      challenged: args.challenged,
      engagement: {
        postsWithLikes: 0,
        postsWithViews: 0,
        totalLikesKnown: 0,
        totalViewsKnown: 0,
        totalRepliesKnown: 0,
        totalRepostsKnown: 0,
        medianLikesKnown: null,
        medianViewsKnown: null,
      },
      sampleNote: "X sample unavailable — do not invent sentiment or popularity",
    }
  }

  const fetchedMs = Date.parse(args.fetchedAt)
  const recentCutoff = fetchedMs - windowHours * 3_600_000
  const authors = new Set(args.posts.map((p) => p.author.toLowerCase()))
  const recent = args.posts.filter((p) => {
    const ts = Date.parse(p.timestamp)
    return Number.isFinite(ts) && ts >= recentCutoff
  })
  const likes = args.posts
    .map((p) => p.engagement.likes)
    .filter((n): n is number => typeof n === "number")
  const views = args.posts
    .map((p) => p.engagement.views)
    .filter((n): n is number => typeof n === "number")
  const replies = args.posts
    .map((p) => p.engagement.replies)
    .filter((n): n is number => typeof n === "number")
  const reposts = args.posts
    .map((p) => p.engagement.reposts)
    .filter((n): n is number => typeof n === "number")

  const degraded = args.challenged || args.queriesSucceeded < args.queriesAttempted
  return {
    status: degraded ? "degraded" : "ok",
    ...(degraded
      ? {
        reason: args.challenged
          ? "X challenge or login wall on one or more searches"
          : "one or more search queries failed",
      }
      : {}),
    postCount: args.posts.length,
    uniqueAuthors: authors.size,
    recentPostCount: recent.length,
    recentWindowHours: windowHours,
    queriesAttempted: args.queriesAttempted,
    queriesSucceeded: args.queriesSucceeded,
    challenged: args.challenged,
    engagement: {
      postsWithLikes: likes.length,
      postsWithViews: views.length,
      totalLikesKnown: likes.reduce((a, b) => a + b, 0),
      totalViewsKnown: views.reduce((a, b) => a + b, 0),
      totalRepliesKnown: replies.reduce((a, b) => a + b, 0),
      totalRepostsKnown: reposts.reduce((a, b) => a + b, 0),
      medianLikesKnown: median(likes),
      medianViewsKnown: median(views),
    },
    sampleNote: [
      "Sample is bounded host X search only — not platform-wide reach.",
      "Missing engagement metrics are unknown, not zero.",
      "Sentiment is model-judged from untrusted tweet text with sample-size caveats.",
    ].join(" "),
  }
}
