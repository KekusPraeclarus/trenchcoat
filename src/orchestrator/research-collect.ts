import { loadConfig, loadEnvSecrets, securityThresholdsFromConfig } from "../lib/config.js"
import { log } from "../lib/log.js"
import type { SnapshotWriter } from "../lib/snapshot.js"
import { resolveFromCandidates, type ResolveCandidate } from "../lib/resolve.js"
import { searchDexScreener } from "../collectors/market/providers.js"
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
import { getChain } from "../lib/chains.js"

export type ResearchSubjectInput = Readonly<{
  subject: string
  chainHint?: CanonicalIdentity["chain"]
  tokenHint?: string
}>

export type ResolveSubjectResult =
  | { status: "resolved"; identity: CanonicalIdentity; candidates: ResolveCandidate[] }
  | { status: "ambiguous"; shortlist: CanonicalIdentity[] }
  | { status: "empty" }
  | { status: "unsupported-chain"; chain: string }

export type ResearchDossierResult = Readonly<{
  snapshotNames: readonly string[]
  security: { status: string; hardFail: boolean; flags: readonly string[] }
  twitterPopularity?: TwitterPopularitySummary
  farcasterPopularity?: FarcasterPopularitySummary
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
    /^(solana|ethereum|base|bsc|robinhood):([A-Za-z0-9]{32,128})$/iu,
  )
  if (chained?.[1] && chained[2]) {
    return {
      chain: chained[1].toLowerCase() as CanonicalIdentity["chain"],
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
      chain: (
        pair.chainId === "eth" ? "ethereum" : pair.chainId
      ) as string,
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
    return { status: "resolved", identity: resolved.identity, candidates }
  }
  if (resolved.status === "ambiguous") {
    return { status: "ambiguous", shortlist: resolved.shortlist }
  }
  if (resolved.status === "unsupported-chain") {
    return { status: "unsupported-chain", chain: resolved.chain }
  }
  return { status: "empty" }
}

export async function writeMarketSnapshots(args: Readonly<{
  writer: SnapshotWriter
  runId: string
  identity: CanonicalIdentity
  fetchedAt: string
  fetcher?: typeof fetch
  snapshotSuffix?: string
}>): Promise<{
  names: string[]
  marketPairCount: number
  security: { status: string; hardFail: boolean; flags: readonly string[] }
}> {
  const fetcher = args.fetcher ?? fetch
  const names: string[] = []
  const marketName = snapshotName("market-dex", args.snapshotSuffix)
  const securityName = snapshotName("security-gate", args.snapshotSuffix)
  const pairs = await searchDexScreener(
    fetcher,
    args.identity.tokenAddress.slice(0, 128),
  )
  const matched = pairs.filter((p) => (
    p.baseToken.address.toLowerCase() === args.identity.tokenAddress.toLowerCase()
    || p.pairAddress.toLowerCase() === args.identity.pairAddress.toLowerCase()
  )).slice(0, 5)

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

  const thresholds = securityThresholdsFromConfig(loadConfig())
  const security = await fetchSecurityGate(
    fetcher,
    args.identity.chain,
    args.identity.tokenAddress,
    thresholds,
  ).catch((error: unknown) => ({
    status: "pending" as const,
    hardFail: false,
    flags: [] as string[],
    reason: error instanceof Error ? error.message : "security check failed",
  }))

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
  return { names, marketPairCount: matched.length, security }
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
}>): Promise<{ names: string[]; popularity: TwitterPopularitySummary }> {
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

function unavailableFarcasterPopularity(
  reason: string,
  recentWindowHours: number,
): FarcasterPopularitySummary {
  return {
    status: "unavailable",
    reason,
    castCount: 0,
    uniqueAuthors: 0,
    recentCastCount: 0,
    recentWindowHours,
    queriesAttempted: 0,
    queriesSucceeded: 0,
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

/** Meta + market + optional socials for a bound identity (shared by cron and operator). */
export async function collectResearchDossier(args: Readonly<{
  writer: SnapshotWriter
  runId: string
  subject: string
  identity: CanonicalIdentity
  fetchedAt: string
  queueId?: string
  fetcher?: typeof fetch
  twitterScrape?: typeof scrapeResearchTokenTwitter
  farcasterSearch?: typeof searchResearchTokenFarcaster
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

  const market = await writeMarketSnapshots({
    writer: args.writer,
    runId: args.runId,
    identity: args.identity,
    fetchedAt: args.fetchedAt,
    ...(args.fetcher ? { fetcher: args.fetcher } : {}),
  })
  snapshotNames.push(...market.names)

  let twitterPopularity: TwitterPopularitySummary | undefined
  if (config.research.twitter_search.enabled) {
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
      snapshotNames.push(...twitter.names)
      twitterPopularity = twitter.popularity
    } catch (error) {
      const reason = error instanceof Error ? error.message : "twitter scrape failed"
      log.warn("twitter research scrape skipped", { detail: reason })
      twitterPopularity = unavailableTwitterPopularity(
        reason,
        config.research.twitter_search.recent_window_hours,
      )
      await args.writer.writeInbox(args.runId, "twitter-popularity", {
        source: "host.twitter-popularity",
        fetchedAt: args.fetchedAt,
        trust: "untrusted-external",
        items: [{
          provenance: `${args.runId}:twitter-popularity`,
          text: JSON.stringify(twitterPopularity),
          ts: args.fetchedAt,
          ageSec: 0,
          freshnessTier: "live",
        }],
      })
      snapshotNames.push("twitter-popularity")
    }
  }

  let farcasterPopularity: FarcasterPopularitySummary | undefined
  if (config.research.farcaster_search.enabled) {
    const secrets = loadEnvSecrets()
    if (secrets.neynarApiKey) {
      try {
        const farcaster = await writeFarcasterResearchSnapshots({
          writer: args.writer,
          runId: args.runId,
          identity: args.identity,
          fetchedAt: args.fetchedAt,
          maxCasts: config.research.farcaster_search.max_casts,
          recentWindowHours: config.research.farcaster_search.recent_window_hours,
          apiKey: secrets.neynarApiKey,
          ...(args.farcasterSearch ? { search: args.farcasterSearch } : {}),
        })
        snapshotNames.push(...farcaster.names)
        farcasterPopularity = farcaster.popularity
      } catch (error) {
        const reason = error instanceof Error ? error.message : "farcaster search failed"
        log.warn("farcaster research search skipped", { detail: reason })
        farcasterPopularity = unavailableFarcasterPopularity(
          reason,
          config.research.farcaster_search.recent_window_hours,
        )
        await args.writer.writeInbox(args.runId, "farcaster-popularity", {
          source: "host.farcaster-popularity",
          fetchedAt: args.fetchedAt,
          trust: "untrusted-external",
          items: [{
            provenance: `${args.runId}:farcaster-popularity`,
            text: JSON.stringify(farcasterPopularity),
            ts: args.fetchedAt,
            ageSec: 0,
            freshnessTier: "live",
          }],
        })
        snapshotNames.push("farcaster-popularity")
      }
    }
  }

  return {
    snapshotNames,
    security: market.security,
    ...(twitterPopularity ? { twitterPopularity } : {}),
    ...(farcasterPopularity ? { farcasterPopularity } : {}),
  }
}
