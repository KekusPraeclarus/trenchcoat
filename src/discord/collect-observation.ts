import { loadConfig, securityThresholdsFromConfig } from "../lib/config.js"
import { getChain } from "../lib/chains.js"
import { searchDexScreener } from "../collectors/market/providers.js"
import { fetchSecurityGate } from "../collectors/market/security.js"
import { scrapeResearchTokenTwitter } from "../collectors/twitter/scrape.js"
import type { CanonicalIdentity } from "../contracts/schemas.js"
import { observationFromCollect } from "./observation.js"
import type { DiscordObservation } from "./schemas.js"

export async function collectWatchObservation(args: Readonly<{
  identity: CanonicalIdentity
  fetchedAt: string
  fetcher?: typeof fetch
}>): Promise<DiscordObservation> {
  const fetcher = args.fetcher ?? fetch
  const config = loadConfig()
  const pairs = await searchDexScreener(fetcher, args.identity.tokenAddress.slice(0, 128))
  const chainDef = getChain(args.identity.chain)
  const matched = pairs.find((p) => (
    (chainDef ? p.chainId === chainDef.dexscreenerChainId || p.chainId === args.identity.chain : true)
    && p.baseToken.address.toLowerCase() === args.identity.tokenAddress.toLowerCase()
  )) ?? pairs[0]

  const market = matched ? {
    priceUsd: matched.priceUsd ?? null,
    liquidityUsd: matched.liquidityUsd ?? null,
    volume24hUsd: matched.volume24hUsd ?? null,
    fdvUsd: matched.fdv ?? null,
    buys24h: matched.buys24h ?? null,
    sells24h: matched.sells24h ?? null,
  } : undefined

  let security = { status: null as string | null, flags: [] as string[] }
  try {
    const gate = await fetchSecurityGate(
      fetcher,
      args.identity.chain,
      args.identity.tokenAddress,
      securityThresholdsFromConfig(config),
    )
    security = { status: gate.status, flags: [...gate.flags] }
  } catch {
    // degraded
  }

  let twitter: Parameters<typeof observationFromCollect>[0]["twitter"]
  if (config.research.twitter_search.enabled) {
    try {
      const scraped = await scrapeResearchTokenTwitter({
        identity: args.identity,
        maxPages: config.research.twitter_search.max_pages_per_query,
        maxPosts: config.research.twitter_search.max_posts,
        fetchedAt: args.fetchedAt,
        recentWindowHours: config.research.twitter_search.recent_window_hours,
      })
      twitter = {
        postCount: scraped.posts.length,
        authorCount: new Set(scraped.posts.map((p) => p.author)).size,
        recentCount: scraped.posts.length,
        posts: scraped.posts.map((p) => ({
          authorId: p.author,
          likes: p.engagement.likes ?? null,
          views: p.engagement.views ?? null,
          replies: p.engagement.replies ?? null,
          reposts: p.engagement.reposts ?? null,
        })),
      }
    } catch {
      // degraded
    }
  }

  return observationFromCollect({
    identity: args.identity,
    fetchedAt: args.fetchedAt,
    market,
    security,
    twitter,
  })
}
