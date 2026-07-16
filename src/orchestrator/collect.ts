import type { SnapshotWriter } from "../lib/snapshot.js"
import { loadConfig } from "../lib/config.js"
import {
  scrapeConfiguredTwitter,
  type TwitterScrapeBundle,
} from "../collectors/twitter/scrape.js"
import type { SourceDiscoveryOrigin } from "../contracts/schemas.js"

export type DiscoverySighting = Readonly<{
  handle: string
  origin: SourceDiscoveryOrigin
}>

export type CollectionSummary = Readonly<{
  snapshotNames: readonly string[]
  fypAuthors: readonly string[]
  discoverySightings: readonly DiscoverySighting[]
  fypPosts: readonly Readonly<{
    id: string
    author: string
    text: string
    url: string
    timestamp: string
  }>[]
  postCount: number
}>

export async function collectForJob(args: Readonly<{
  job: string
  runId: string
  writer: SnapshotWriter
  fetchedAt: string
}>): Promise<CollectionSummary> {
  if (args.job !== "list-scan") {
    await args.writer.writeInbox(args.runId, "meta", {
      source: "host.collector",
      fetchedAt: args.fetchedAt,
      trust: "untrusted-external",
      items: [{
        provenance: `${args.runId}:meta`,
        text: `job=${args.job}`,
        ts: args.fetchedAt,
        ageSec: 0,
        freshnessTier: "live",
      }],
    })
    return {
      snapshotNames: ["meta"],
      fypAuthors: [],
      discoverySightings: [],
      fypPosts: [],
      postCount: 1,
    }
  }

  const config = loadConfig()
  const bundles = await scrapeConfiguredTwitter(config)
  const names: string[] = []
  const fypAuthors = new Set<string>()
  const sightings: DiscoverySighting[] = []
  const seenKeys = new Set<string>()
  const fypPosts: CollectionSummary["fypPosts"][number][] = []
  let postCount = 0

  for (const bundle of bundles) {
    if (bundle.challenged) {
      throw new Error(
        `Twitter ${bundle.target.label} needs headful re-auth: pnpm dev:cli auth twitter`,
      )
    }
    const name = sanitizeSnapshotName(bundle.target.label)
    names.push(name)
    postCount += bundle.posts.length
    const origin = originForTarget(bundle)
    if (origin) {
      for (const post of bundle.posts) {
        const key = `${origin}:${post.author.toLowerCase()}`
        if (!seenKeys.has(key)) {
          seenKeys.add(key)
          sightings.push({ handle: post.author, origin })
        }
        if (origin === "fyp") {
          fypAuthors.add(post.author)
          fypPosts.push({
            id: post.id,
            author: post.author,
            text: post.text,
            url: post.url,
            timestamp: post.timestamp,
          })
        }
      }
    }
    await writeTwitterBundle(args, name, bundle)
  }

  return {
    snapshotNames: names,
    fypAuthors: [...fypAuthors].sort(),
    discoverySightings: sightings.sort((a, b) => (
      a.origin === b.origin
        ? a.handle.localeCompare(b.handle)
        : a.origin.localeCompare(b.origin)
    )),
    fypPosts,
    postCount,
  }
}

function originForTarget(bundle: TwitterScrapeBundle): SourceDiscoveryOrigin | undefined {
  if (bundle.target.kind === "home") return "fyp"
  if (bundle.target.label === "operator-list-1") return "operator-list-1"
  if (bundle.target.label === "operator-list-2") return "operator-list-2"
  return undefined
}

async function writeTwitterBundle(
  args: Readonly<{
    runId: string
    writer: SnapshotWriter
    fetchedAt: string
  }>,
  name: string,
  bundle: TwitterScrapeBundle,
): Promise<void> {
  const fetchedMs = Date.parse(args.fetchedAt)
  await args.writer.writeInbox(args.runId, `twitter-${name}`, {
    source: `twitter.${bundle.target.label}`,
    fetchedAt: args.fetchedAt,
    trust: "untrusted-external",
    items: bundle.posts.map((post) => {
      const ageSec = Math.max(
        0,
        Math.floor((fetchedMs - Date.parse(post.timestamp)) / 1_000),
      )
      return {
        provenance: post.provenance,
        text: post.text,
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
}

function sanitizeSnapshotName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 64)
}
