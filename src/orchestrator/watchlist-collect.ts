import { join } from "node:path"
import { loadConfig, loadEnvSecrets } from "../lib/config.js"
import { getChain, validateAddress } from "../lib/chains.js"
import { StateStore } from "../lib/state.js"
import type { SnapshotWriter } from "../lib/snapshot.js"
import type { CanonicalIdentity } from "../contracts/schemas.js"
import type { scrapeResearchTokenTwitter } from "../collectors/twitter/scrape.js"
import type { searchResearchTokenFarcaster } from "../collectors/farcaster/popularity.js"
import {
  writeFarcasterResearchSnapshots,
  writeMarketSnapshots,
  writeTwitterResearchSnapshots,
} from "./research-collect.js"

export type WatchlistCollectResult = Readonly<{
  snapshotNames: readonly string[]
  postCount: number
  subjectsConsidered: number
  subjectsWithUsableEvidence: number
  skipAgent: boolean
  collectionStatus: "completed" | "degraded" | "skipped"
}>

function hasValidIdentity(identity: CanonicalIdentity): boolean {
  const chain = getChain(identity.chain)
  return (
    (identity.resolution === "resolved" || identity.resolution === "model-confirmed")
    && chain !== undefined
    && validateAddress(chain.addressFormat, identity.tokenAddress)
    && validateAddress(chain.addressFormat, identity.pairAddress)
  )
}

function snapshotSuffix(identity: CanonicalIdentity, index: number, total: number): string | undefined {
  if (total === 1) return undefined
  return `${index + 1}-${identity.tokenAddress.slice(-12)}`
}

export async function collectWatchlistScan(args: Readonly<{
  runId: string
  writer: SnapshotWriter
  fetchedAt: string
  agentRoot: string
  archiveRoot?: string
  fetcher?: typeof fetch
  twitterScrape?: typeof scrapeResearchTokenTwitter
  farcasterSearch?: typeof searchResearchTokenFarcaster
}>): Promise<WatchlistCollectResult> {
  const state = new StateStore(join(args.agentRoot, "state"))
  const active = state.loadWatchlist().entries.filter((entry) => (
    entry.status === "tracking" || entry.status === "watching"
  ))

  if (active.length === 0) {
    await args.writer.writeInbox(args.runId, "watchlist-collection-status", {
      source: "host.collector",
      fetchedAt: args.fetchedAt,
      trust: "untrusted-external",
      items: [{
        provenance: `${args.runId}:watchlist-status`,
        text: "status=skipped reason=no-active-watchlist-subjects",
        ts: args.fetchedAt,
        ageSec: 0,
        freshnessTier: "live",
      }],
    })
    return {
      snapshotNames: ["watchlist-collection-status"],
      postCount: 1,
      subjectsConsidered: 0,
      subjectsWithUsableEvidence: 0,
      skipAgent: true,
      collectionStatus: "skipped",
    }
  }

  const config = loadConfig()
  // Both flags must agree, so a disabled Farcaster lane makes no research calls
  const farcasterSearchEnabled = config.farcaster.enabled
    && config.research.farcaster_search.enabled
  const farcasterApiKey = farcasterSearchEnabled
    ? loadEnvSecrets().neynarApiKey
    : undefined
  const snapshotNames: string[] = []
  const statusLines: string[] = []
  let usableSubjects = 0

  for (const [index, entry] of active.entries()) {
    const { identity } = entry
    const subject = identity.symbolDisplay
    const suffix = snapshotSuffix(identity, index, active.length)

    if (!hasValidIdentity(identity)) {
      statusLines.push(`subject=${subject} status=invalid-identity`)
      continue
    }

    try {
      // No cheap prior liquidity in watchlist state; first snapshot omits delta.
      const market = await writeMarketSnapshots({
        writer: args.writer,
        runId: args.runId,
        identity,
        fetchedAt: args.fetchedAt,
        ...(args.fetcher ? { fetcher: args.fetcher } : {}),
        ...(suffix ? { snapshotSuffix: suffix } : {}),
      })
      snapshotNames.push(...market.names)
      const mq = market.marketQuality
        ? ` marketQuality=${market.marketQuality.status}`
        : ""
      if (market.marketPairCount > 0) {
        usableSubjects += 1
        statusLines.push(
          `subject=${subject} market=ok security=${market.security.status}${mq}`,
        )
      } else {
        statusLines.push(
          `subject=${subject} market=empty security=${market.security.status}${mq}`,
        )
      }
    } catch {
      statusLines.push(`subject=${subject} market=failed`)
      continue
    }

    if (config.research.twitter_search.enabled) {
      try {
        const twitter = await writeTwitterResearchSnapshots({
          writer: args.writer,
          runId: args.runId,
          identity,
          fetchedAt: args.fetchedAt,
          maxPages: config.research.twitter_search.max_pages_per_query,
          maxPosts: config.research.twitter_search.max_posts,
          recentWindowHours: config.research.twitter_search.recent_window_hours,
          ...(args.twitterScrape ? { scrape: args.twitterScrape } : {}),
          ...(suffix ? { snapshotSuffix: suffix } : {}),
        })
        snapshotNames.push(...twitter.names)
        statusLines.push(`subject=${subject} twitter=ok`)
      } catch {
        statusLines.push(`subject=${subject} twitter=unavailable`)
      }
    }

    if (farcasterSearchEnabled) {
      if (!farcasterApiKey) {
        statusLines.push(`subject=${subject} farcaster=unconfigured`)
        continue
      }
      try {
        const farcaster = await writeFarcasterResearchSnapshots({
          writer: args.writer,
          runId: args.runId,
          identity,
          fetchedAt: args.fetchedAt,
          maxCasts: config.research.farcaster_search.max_casts,
          recentWindowHours: config.research.farcaster_search.recent_window_hours,
          apiKey: farcasterApiKey,
          ...(args.farcasterSearch ? { search: args.farcasterSearch } : {}),
          ...(suffix ? { snapshotSuffix: suffix } : {}),
        })
        snapshotNames.push(...farcaster.names)
        statusLines.push(`subject=${subject} farcaster=ok`)
      } catch {
        statusLines.push(`subject=${subject} farcaster=unavailable`)
      }
    }
  }

  const collectionStatus = usableSubjects > 0 ? "completed" : "degraded"
  const skipAgent = usableSubjects === 0
  statusLines.push(
    `status=${collectionStatus} subjects=${active.length} usableSubjects=${usableSubjects} skipAgent=${skipAgent}`,
  )
  await args.writer.writeInbox(args.runId, "watchlist-collection-status", {
    source: "host.collector",
    fetchedAt: args.fetchedAt,
    trust: "untrusted-external",
    items: statusLines.map((text, index) => ({
      provenance: `${args.runId}:watchlist-status:${index}`,
      text,
      ts: args.fetchedAt,
      ageSec: 0,
      freshnessTier: "live" as const,
    })),
  })
  snapshotNames.push("watchlist-collection-status")

  return {
    snapshotNames,
    postCount: snapshotNames.length,
    subjectsConsidered: active.length,
    subjectsWithUsableEvidence: usableSubjects,
    skipAgent,
    collectionStatus,
  }
}
