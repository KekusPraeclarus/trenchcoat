import { loadConfig, securityThresholdsFromConfig } from "../lib/config.js"
import { log } from "../lib/log.js"
import type { SnapshotWriter } from "../lib/snapshot.js"
import { resolveFromCandidates, type ResolveCandidate } from "../lib/resolve.js"
import { searchDexScreener, type MarketPair } from "../collectors/market/providers.js"
import { fetchSecurityGate } from "../collectors/market/security.js"
import { scrapeResearchTokenTwitter } from "../collectors/twitter/scrape.js"
import type { TwitterPopularitySummary } from "../collectors/twitter/popularity.js"
import type { TwitterPost } from "../collectors/twitter/session.js"
import {
  searchResearchTokenFarcaster,
  type FarcasterPopularitySummary,
} from "../collectors/farcaster/popularity.js"
import type { FarcasterCast } from "../collectors/farcaster/neynar.js"
import type { CanonicalIdentity } from "../contracts/schemas.js"
import { getChain, chainSlugFromProviderId, normalizeChainSlug } from "../lib/chains.js"
import {
  liveTokenContext,
  loadObservationCache,
  observationEventTime,
  type FomoObservation,
} from "../collectors/fomo/observations.js"
import { freshnessFromIso } from "../collectors/fomo/freshness.js"

const FOMO_CONTEXT_JSON_MAX = 1_500

function compactFomoRecord(item: FomoObservation): string {
  try {
    return JSON.stringify(item.record).slice(0, FOMO_CONTEXT_JSON_MAX)
  } catch {
    return "{}"
  }
}

async function writeFomoContextSnapshot(args: Readonly<{
  writer: SnapshotWriter
  runId: string
  identity: CanonicalIdentity
  fetchedAt: string
  archiveRoot: string
}>): Promise<string | undefined> {
  const config = loadConfig()
  if (!config.fomo.enabled) return undefined

  try {
    const cache = loadObservationCache(args.archiveRoot)
    const live = cache
      ? liveTokenContext(
        cache,
        args.identity.chain,
        args.identity.tokenAddress,
        args.fetchedAt,
      )
      : []

    const items = []
    for (const [index, item] of live.entries()) {
      const eventIso = observationEventTime(item)
      const fields = freshnessFromIso(eventIso, args.fetchedAt)
      if (!fields.ok || fields.ts === undefined || fields.ageSec === undefined || !fields.freshnessTier) {
        continue
      }
      items.push({
        provenance: `${args.runId}:fomo-context:${item.kind}:${index}`,
        text: `kind=${item.kind} ${compactFomoRecord(item)}`,
        ts: fields.ts,
        ageSec: fields.ageSec,
        freshnessTier: fields.freshnessTier,
        dedupeKey: `${item.kind}:${fields.ts}:${index}`,
      })
    }

    if (items.length === 0) {
      await args.writer.writeInbox(args.runId, "fomo-context", {
        source: "host.fomo-observation-cache",
        fetchedAt: args.fetchedAt,
        trust: "untrusted-external",
        items: [{
          provenance: `${args.runId}:fomo-context:status`,
          text: "kind=status status=empty-or-unavailable",
          ts: args.fetchedAt,
          ageSec: 0,
          freshnessTier: "live",
        }],
      })
      return "fomo-context"
    }

    await args.writer.writeInbox(args.runId, "fomo-context", {
      source: "host.fomo-observation-cache",
      fetchedAt: args.fetchedAt,
      trust: "untrusted-external",
      items,
    })
    return "fomo-context"
  } catch {
    await args.writer.writeInbox(args.runId, "fomo-context", {
      source: "host.fomo-observation-cache",
      fetchedAt: args.fetchedAt,
      trust: "untrusted-external",
      items: [{
        provenance: `${args.runId}:fomo-context:status`,
        text: "kind=status status=cache-unavailable",
        ts: args.fetchedAt,
        ageSec: 0,
        freshnessTier: "live",
      }],
    }).catch(() => undefined)
    return "fomo-context"
  }
}

export type ResearchSubjectInput = Readonly<{
  subject: string
  chainHint?: CanonicalIdentity["chain"]
  tokenHint?: string
}>

export type ResolveSubjectResult =
  | {
    status: "resolved"
    identity: CanonicalIdentity
    candidates: ResolveCandidate[]
    /** Full DexScreener pairs from the resolve search — reuse to skip a second lookup */
    pairs: readonly MarketPair[]
  }
  | { status: "ambiguous"; shortlist: CanonicalIdentity[] }
  | { status: "empty" }
  | { status: "unsupported-chain"; chain: string }

export type ResearchDossierMarket = Readonly<{
  priceUsd: number | null
  liquidityUsd: number | null
  volume24hUsd: number | null
  fdvUsd: number | null
  buys24h: number | null
  sells24h: number | null
}>

export type ResearchDossierTwitter = Readonly<{
  postCount: number
  authorCount: number
  recentCount: number
  posts: readonly Readonly<{
    authorId?: string
    likes?: number | null
    views?: number | null
    replies?: number | null
    reposts?: number | null
  }>[]
}>

export type ResearchDossierResult = Readonly<{
  snapshotNames: readonly string[]
  security: { status: string; hardFail: boolean; flags: readonly string[] }
  twitterPopularity?: TwitterPopularitySummary
  market?: ResearchDossierMarket
  twitter?: ResearchDossierTwitter
}>

function snapshotName(base: string, suffix?: string): string {
  if (!suffix) return base
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,96}$/u.test(suffix)) {
    throw new TypeError("Snapshot suffix is unsafe")
  }
  return `${base}-${suffix}`
}

export function parseSubjectHints(input: ResearchSubjectInput): {
  chain?: CanonicalIdentity["chain"]
  token?: string
  query: string
} {
  const chained = input.subject.match(
    /^(solana|ethereum|base|bsc|robinhood|plasma|hyperliquid|hyperevm):([A-Za-z0-9]{32,128})$/iu,
  )
  if (chained?.[1] && chained[2]) {
    const chain = normalizeChainSlug(chained[1]) as CanonicalIdentity["chain"] | undefined
    if (!chain) {
      return { query: chained[2] }
    }
    return {
      chain,
      token: chained[2],
      query: chained[2],
    }
  }
  return {
    ...(input.chainHint ? { chain: input.chainHint } : {}),
    ...(input.tokenHint ? { token: input.tokenHint } : {}),
    query: input.tokenHint ?? input.subject,
  }
}

export async function resolveResearchSubject(
  input: ResearchSubjectInput,
  fetcher: typeof fetch = fetch,
): Promise<ResolveSubjectResult> {
  const hints = parseSubjectHints(input)
  const pairs = await searchDexScreener(fetcher, hints.query.slice(0, 128))
  const expectedSymbol = !hints.token && /^[A-Za-z][A-Za-z0-9]{1,15}$/u.test(hints.query.trim())
    ? hints.query.trim()
    : undefined
  const candidates: ResolveCandidate[] = pairs
    .filter((pair) => {
      if (hints.chain) {
        const chain = getChain(hints.chain)
        if (!chain) return false
        if (pair.chainId !== chain.dexscreenerChainId && pair.chainId !== hints.chain) {
          return false
        }
      }
      if (hints.token) {
        return pair.baseToken.address.toLowerCase() === hints.token.toLowerCase()
          || pair.pairAddress.toLowerCase() === hints.token.toLowerCase()
      }
      return true
    })
    .map((pair) => ({
      chain: chainSlugFromProviderId(pair.chainId) ?? pair.chainId,
      tokenAddress: pair.baseToken.address,
      pairAddress: pair.pairAddress,
      symbolDisplay: pair.baseToken.symbol,
      liquidityUsd: pair.liquidityUsd ?? 0,
      volume24hUsd: pair.volume24hUsd ?? 0,
    }))
    .filter((c) => Boolean(getChain(c.chain)))

  const resolved = resolveFromCandidates(candidates, {
    ...(expectedSymbol ? { expectedSymbol } : {}),
  })
  if (resolved.status === "resolved") {
    return {
      status: "resolved",
      identity: resolved.identity,
      candidates,
      pairs,
    }
  }
  if (resolved.status === "ambiguous") {
    return { status: "ambiguous", shortlist: resolved.shortlist }
  }
  if (resolved.status === "unsupported-chain") {
    return { status: "unsupported-chain", chain: resolved.chain }
  }
  return { status: "empty" }
}

function matchPairsForIdentity(
  pairs: readonly MarketPair[],
  identity: CanonicalIdentity,
): MarketPair[] {
  return pairs.filter((p) => (
    p.baseToken.address.toLowerCase() === identity.tokenAddress.toLowerCase()
    || p.pairAddress.toLowerCase() === identity.pairAddress.toLowerCase()
  )).slice(0, 5)
}

export function marketSummaryFromPairs(
  matched: readonly MarketPair[],
): ResearchDossierMarket | undefined {
  const primary = matched[0]
  if (!primary) return undefined
  return {
    priceUsd: primary.priceUsd ?? null,
    liquidityUsd: primary.liquidityUsd ?? null,
    volume24hUsd: primary.volume24hUsd ?? null,
    fdvUsd: primary.fdv ?? null,
    buys24h: primary.buys24h ?? null,
    sells24h: primary.sells24h ?? null,
  }
}

export async function writeMarketSnapshots(args: Readonly<{
  writer: SnapshotWriter
  runId: string
  identity: CanonicalIdentity
  fetchedAt: string
  fetcher?: typeof fetch
  snapshotSuffix?: string
  /** When set, skip a second DexScreener search */
  pairs?: readonly MarketPair[]
}>): Promise<{
  names: string[]
  marketPairCount: number
  security: { status: string; hardFail: boolean; flags: readonly string[] }
  market?: ResearchDossierMarket
}> {
  const fetcher = args.fetcher ?? fetch
  const names: string[] = []
  const marketName = snapshotName("market-dex", args.snapshotSuffix)
  const securityName = snapshotName("security-gate", args.snapshotSuffix)
  const thresholds = securityThresholdsFromConfig(loadConfig())

  const [pairs, security] = await Promise.all([
    args.pairs
      ? Promise.resolve([...args.pairs])
      : searchDexScreener(fetcher, args.identity.tokenAddress.slice(0, 128)),
    fetchSecurityGate(
      fetcher,
      args.identity.chain,
      args.identity.tokenAddress,
      thresholds,
    ).catch((error: unknown) => ({
      status: "pending" as const,
      hardFail: false,
      flags: [] as string[],
      reason: error instanceof Error ? error.message : "security check failed",
    })),
  ])

  const matched = matchPairsForIdentity(pairs, args.identity)

  await args.writer.writeInbox(args.runId, marketName, {
    source: "dexscreener.search",
    fetchedAt: args.fetchedAt,
    trust: "untrusted-external",
    items: matched.map((pair, index) => ({
      provenance: `${args.runId}:dex:${index}`,
      text: [
        `symbol=${pair.baseToken.symbol}`,
        `chain=${pair.chainId}`,
        `token=${pair.baseToken.address}`,
        `pair=${pair.pairAddress}`,
        `priceUsd=${pair.priceUsd ?? "n/a"}`,
        `liquidityUsd=${pair.liquidityUsd ?? "n/a"}`,
        `fdv=${pair.fdv ?? "n/a"}`,
        `buys24h=${pair.buys24h}`,
        `sells24h=${pair.sells24h}`,
      ].join(" "),
      url: pair.url,
      ts: args.fetchedAt,
      ageSec: 0,
      freshnessTier: "live" as const,
      dedupeKey: pair.pairAddress,
    })),
  })
  names.push(marketName)

  await args.writer.writeInbox(args.runId, securityName, {
    source: "host.security",
    fetchedAt: args.fetchedAt,
    trust: "untrusted-external",
    items: [{
      provenance: `${args.runId}:security:${args.identity.chain}:${args.identity.tokenAddress}`,
      text: [
        `chain=${args.identity.chain}`,
        `token=${args.identity.tokenAddress}`,
        `pair=${args.identity.pairAddress}`,
        `status=${security.status}`,
        `hardFail=${security.hardFail}`,
        `flags=${security.flags.join(",") || "none"}`,
        `reason=${"reason" in security ? security.reason ?? "" : ""}`,
      ].join(" "),
      ts: args.fetchedAt,
      ageSec: 0,
      freshnessTier: "live",
      dedupeKey: `${args.identity.chain}:${args.identity.tokenAddress}`,
    }],
  })
  names.push(securityName)
  const market = marketSummaryFromPairs(matched)
  return {
    names,
    marketPairCount: matched.length,
    security,
    ...(market ? { market } : {}),
  }
}

export async function writeTwitterResearchSnapshots(args: Readonly<{
  writer: SnapshotWriter
  runId: string
  identity: CanonicalIdentity
  fetchedAt: string
  maxPages: number
  maxPosts: number
  recentWindowHours: number
  scrape?: typeof scrapeResearchTokenTwitter
  snapshotSuffix?: string
}>): Promise<{
  names: string[]
  popularity: TwitterPopularitySummary
  twitter: ResearchDossierTwitter
}> {
  const scrape = args.scrape ?? scrapeResearchTokenTwitter
  const searchName = snapshotName("twitter-token-search", args.snapshotSuffix)
  const popularityName = snapshotName("twitter-popularity", args.snapshotSuffix)
  const result = await scrape({
    identity: args.identity,
    maxPages: args.maxPages,
    maxPosts: args.maxPosts,
    fetchedAt: args.fetchedAt,
    recentWindowHours: args.recentWindowHours,
  })
  const popularity = result.popularity
  const twitter: ResearchDossierTwitter = {
    postCount: popularity.postCount,
    authorCount: popularity.uniqueAuthors,
    recentCount: popularity.recentPostCount,
    posts: result.posts.map((post) => ({
      authorId: post.author,
      likes: post.engagement.likes ?? null,
      views: post.engagement.views ?? null,
      replies: post.engagement.replies ?? null,
      reposts: post.engagement.reposts ?? null,
    })),
  }

  const fetchedMs = Date.parse(args.fetchedAt)
  await args.writer.writeInbox(args.runId, searchName, {
    source: "twitter.research-search",
    fetchedAt: args.fetchedAt,
    trust: "untrusted-external",
    items: result.posts.map((post: TwitterPost) => {
      const ageSec = Math.max(
        0,
        Math.floor((fetchedMs - Date.parse(post.timestamp)) / 1_000),
      )
      const eng = post.engagement
      return {
        provenance: post.provenance,
        text: [
          post.text,
          `likes=${eng.likes ?? "unknown"}`,
          `replies=${eng.replies ?? "unknown"}`,
          `reposts=${eng.reposts ?? "unknown"}`,
          `views=${eng.views ?? "unknown"}`,
        ].join("\n"),
        url: post.url,
        ts: post.timestamp,
        ageSec,
        freshnessTier: ageSec <= 6 * 3_600
          ? "live" as const
          : ageSec <= 48 * 3_600
            ? "stale" as const
            : "expired" as const,
        dedupeKey: post.id,
      }
    }),
  })

  await args.writer.writeInbox(args.runId, popularityName, {
    source: "host.twitter-popularity",
    fetchedAt: args.fetchedAt,
    trust: "untrusted-external",
    items: [{
      provenance: `${args.runId}:twitter-popularity`,
      text: JSON.stringify(popularity),
      ts: args.fetchedAt,
      ageSec: 0,
      freshnessTier: "live",
      dedupeKey: `${args.runId}:twitter-popularity`,
    }],
  })

  return {
    names: [searchName, popularityName],
    popularity,
    twitter,
  }
}

export async function writeFarcasterResearchSnapshots(args: Readonly<{
  writer: SnapshotWriter
  runId: string
  identity: CanonicalIdentity
  fetchedAt: string
  maxCasts: number
  recentWindowHours: number
  apiKey: string
  search?: typeof searchResearchTokenFarcaster
  snapshotSuffix?: string
}>): Promise<{ names: string[]; popularity: FarcasterPopularitySummary }> {
  const search = args.search ?? searchResearchTokenFarcaster
  const searchName = snapshotName("farcaster-token-search", args.snapshotSuffix)
  const popularityName = snapshotName("farcaster-popularity", args.snapshotSuffix)
  const result = await search({
    identity: args.identity,
    apiKey: args.apiKey,
    maxCasts: args.maxCasts,
    fetchedAt: args.fetchedAt,
    recentWindowHours: args.recentWindowHours,
  })
  const popularity = result.popularity
  const fetchedMs = Date.parse(args.fetchedAt)

  await args.writer.writeInbox(args.runId, searchName, {
    source: "farcaster.research-search",
    fetchedAt: args.fetchedAt,
    trust: "untrusted-external",
    items: result.casts.map((cast: FarcasterCast) => {
      const ageSec = Math.max(
        0,
        Math.floor((fetchedMs - Date.parse(cast.timestamp)) / 1_000),
      )
      const eng = cast.engagement
      return {
        provenance: cast.provenance,
        text: [
          cast.text,
          `likes=${eng.likes ?? "unknown"}`,
          `replies=${eng.replies ?? "unknown"}`,
          `recasts=${eng.recasts ?? "unknown"}`,
        ].join("\n"),
        ...(cast.url ? { url: cast.url } : {}),
        ts: cast.timestamp,
        ageSec,
        freshnessTier: ageSec <= 6 * 3_600
          ? "live" as const
          : ageSec <= 48 * 3_600
            ? "stale" as const
            : "expired" as const,
        dedupeKey: cast.hash,
      }
    }),
  })

  await args.writer.writeInbox(args.runId, popularityName, {
    source: "host.farcaster-popularity",
    fetchedAt: args.fetchedAt,
    trust: "untrusted-external",
    items: [{
      provenance: `${args.runId}:farcaster-popularity`,
      text: JSON.stringify(popularity),
      ts: args.fetchedAt,
      ageSec: 0,
      freshnessTier: "live",
      dedupeKey: `${args.runId}:farcaster-popularity`,
    }],
  })

  return {
    names: [searchName, popularityName],
    popularity,
  }
}

function unavailableTwitterPopularity(
  reason: string,
  recentWindowHours: number,
): TwitterPopularitySummary {
  return {
    status: "unavailable",
    reason,
    postCount: 0,
    uniqueAuthors: 0,
    recentPostCount: 0,
    recentWindowHours,
    queriesAttempted: 0,
    queriesSucceeded: 0,
    challenged: false,
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

/** Meta + market + optional X for a bound identity (shared by cron and operator). */
export async function collectResearchDossier(args: Readonly<{
  writer: SnapshotWriter
  runId: string
  subject: string
  identity: CanonicalIdentity
  fetchedAt: string
  queueId?: string
  archiveRoot?: string
  fetcher?: typeof fetch
  twitterScrape?: typeof scrapeResearchTokenTwitter
  /** Pairs from resolveResearchSubject — skips a second DexScreener search */
  pairs?: readonly MarketPair[]
}>): Promise<ResearchDossierResult> {
  const config = loadConfig()
  const snapshotNames: string[] = []

  const metaLines = [
    "job=research",
    `subject=${args.subject}`,
    args.queueId ? `queueId=${args.queueId}` : "",
    `chain=${args.identity.chain}`,
    `tokenAddress=${args.identity.tokenAddress}`,
    `pairAddress=${args.identity.pairAddress}`,
    `symbol=${args.identity.symbolDisplay}`,
  ].filter(Boolean)
  await args.writer.writeInbox(args.runId, "meta", {
    source: "host.collector",
    fetchedAt: args.fetchedAt,
    trust: "untrusted-external",
    items: [{
      provenance: `${args.runId}:meta`,
      text: metaLines.join(" "),
      ts: args.fetchedAt,
      ageSec: 0,
      freshnessTier: "live",
    }],
  })
  snapshotNames.push("meta")

  // Independent I/O after meta: market/security, cached FOMO, and X
  const marketPromise = writeMarketSnapshots({
    writer: args.writer,
    runId: args.runId,
    identity: args.identity,
    fetchedAt: args.fetchedAt,
    ...(args.fetcher ? { fetcher: args.fetcher } : {}),
    ...(args.pairs ? { pairs: args.pairs } : {}),
  })

  const fomoPromise = args.archiveRoot
    ? writeFomoContextSnapshot({
      writer: args.writer,
      runId: args.runId,
      identity: args.identity,
      fetchedAt: args.fetchedAt,
      archiveRoot: args.archiveRoot,
    })
    : Promise.resolve(undefined)

  const twitterPromise = (async (): Promise<{
    names: string[]
    popularity?: TwitterPopularitySummary
    twitter?: ResearchDossierTwitter
  }> => {
    if (!config.research.twitter_search.enabled) {
      return { names: [] }
    }
    try {
      const twitter = await writeTwitterResearchSnapshots({
        writer: args.writer,
        runId: args.runId,
        identity: args.identity,
        fetchedAt: args.fetchedAt,
        maxPages: config.research.twitter_search.max_pages_per_query,
        maxPosts: config.research.twitter_search.max_posts,
        recentWindowHours: config.research.twitter_search.recent_window_hours,
        ...(args.twitterScrape ? { scrape: args.twitterScrape } : {}),
      })
      return {
        names: twitter.names,
        popularity: twitter.popularity,
        twitter: twitter.twitter,
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "twitter scrape failed"
      log.warn("twitter research scrape skipped", { detail: reason })
      const popularity = unavailableTwitterPopularity(
        reason,
        config.research.twitter_search.recent_window_hours,
      )
      await args.writer.writeInbox(args.runId, "twitter-popularity", {
        source: "host.twitter-popularity",
        fetchedAt: args.fetchedAt,
        trust: "untrusted-external",
        items: [{
          provenance: `${args.runId}:twitter-popularity`,
          text: JSON.stringify(popularity),
          ts: args.fetchedAt,
          ageSec: 0,
          freshnessTier: "live",
        }],
      })
      return {
        names: ["twitter-popularity"],
        popularity,
        twitter: {
          postCount: 0,
          authorCount: 0,
          recentCount: 0,
          posts: [],
        },
      }
    }
  })()

  const [market, fomoName, twitterBranch] = await Promise.all([
    marketPromise,
    fomoPromise,
    twitterPromise,
  ])

  // Deterministic order after settle: market/security, fomo, twitter
  snapshotNames.push(...market.names)
  if (fomoName) snapshotNames.push(fomoName)
  snapshotNames.push(...twitterBranch.names)

  return {
    snapshotNames,
    security: market.security,
    ...(twitterBranch.popularity ? { twitterPopularity: twitterBranch.popularity } : {}),
    ...(market.market ? { market: market.market } : {}),
    ...(twitterBranch.twitter ? { twitter: twitterBranch.twitter } : {}),
  }
}
