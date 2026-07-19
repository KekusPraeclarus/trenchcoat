import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { SnapshotWriter } from "../lib/snapshot.js"
import { loadConfig } from "../lib/config.js"
import { StateStore } from "../lib/state.js"
import { writeAtomicFile } from "../lib/fs-atomic.js"
import { freshnessFromIso, isLiveEligible } from "../collectors/fomo/freshness.js"
import {
  loadUsageDay,
  remainingBudget,
} from "../collectors/twitter/fomo-source-review-usage.js"
import { scrapeProfileHistory } from "../collectors/twitter/profile-history.js"
import type { CollectionSummary } from "./collect.js"
import type { InjectedHistoryPost } from "./fomo-x-source-review.js"

function skipSummary(names: string[], status: string): CollectionSummary {
  return {
    snapshotNames: names,
    fypAuthors: [],
    discoverySightings: [],
    fcDiscoverySightings: [],
    fypPosts: [],
    fypCasts: [],
    postCount: 0,
    skipAgent: true,
    collectionKind: "host-only",
    collectionStatus: status,
  }
}

async function writeSkip(
  args: Readonly<{ runId: string, writer: SnapshotWriter, fetchedAt: string }>,
  reason: string,
): Promise<string[]> {
  await args.writer.writeInbox(args.runId, "collection-status", {
    source: "host.fomo-narrative-source-scan",
    fetchedAt: args.fetchedAt,
    trust: "untrusted-external",
    items: [{
      provenance: `${args.runId}:fomo-narrative:${reason}`,
      text: `kind=skip reason=${reason}`,
      ts: args.fetchedAt,
      ageSec: 0,
      freshnessTier: "live",
    }],
  })
  return ["collection-status"]
}

function cursorPath(archiveRoot: string): string {
  return join(archiveRoot, "provider-cursors", "fomo", "narrative-source-scan.json")
}

async function loadCursor(archiveRoot: string): Promise<string | undefined> {
  const path = cursorPath(archiveRoot)
  if (!existsSync(path)) return undefined
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { nextHandle?: string }
    return raw.nextHandle
  } catch {
    return undefined
  }
}

async function saveCursor(archiveRoot: string, nextHandle: string | undefined): Promise<void> {
  await writeAtomicFile(
    cursorPath(archiveRoot),
    `${JSON.stringify({ schema: 1, nextHandle: nextHandle ?? null }, null, 2)}\n`,
  )
}

/**
 * Host-only round-robin of probation narrative handles. Collects live (<=6h)
 * posts; accepts injected posts for tests so Playwright is never required.
 */
export async function collectFomoNarrativeSourceScan(args: Readonly<{
  runId: string
  writer: SnapshotWriter
  fetchedAt: string
  agentRoot: string
  archiveRoot: string
  posts?: readonly InjectedHistoryPost[]
}>): Promise<CollectionSummary> {
  const config = loadConfig()
  if (!config.fomo.enabled || !config.fomo.narrative_source_probation.enabled) {
    return skipSummary(await writeSkip(args, "fomo-disabled"), "fomo-disabled")
  }

  const state = new StateStore(join(args.agentRoot, "state"))
  const file = state.loadXNarrativeSources()
  const probation = file.sources
    .filter((item) => item.status === "probation")
    .sort((a, b) => a.handle.localeCompare(b.handle))
  if (probation.length === 0) {
    return skipSummary(await writeSkip(args, "fomo-narrative-empty"), "fomo-narrative-empty")
  }

  const cursor = await loadCursor(args.archiveRoot)
  let startIdx = 0
  if (cursor) {
    const found = probation.findIndex((item) => item.handle === cursor)
    startIdx = found >= 0 ? found : 0
  }

  const maxProfiles = config.fomo.narrative_source_probation.max_profiles_per_scan
  const selected = []
  for (let i = 0; i < Math.min(maxProfiles, probation.length); i += 1) {
    selected.push(probation[(startIdx + i) % probation.length]!)
  }
  const nextHandle = probation[(startIdx + selected.length) % probation.length]?.handle
  await saveCursor(args.archiveRoot, nextHandle)

  const selectedHandles = new Set(selected.map((item) => item.handle))
  let candidates: InjectedHistoryPost[]

  if (args.posts) {
    candidates = [...args.posts]
  } else {
    const pageBudget = config.fomo.narrative_source_probation.daily_profile_page_budget
    const maxPages = config.fomo.narrative_source_probation.max_pages_per_profile
    const day = args.fetchedAt.slice(0, 10)
    const scraped: InjectedHistoryPost[] = []
    const scrapeNotes: string[] = []

    for (const source of selected) {
      const usage = loadUsageDay(args.archiveRoot, day, pageBudget)
      if (remainingBudget(usage) <= 0) {
        scrapeNotes.push(`${source.handle}:budget-exhausted`)
        break
      }

      const result = await scrapeProfileHistory({
        handle: source.handle,
        maxPages,
        maxPosts: 50,
        lookbackDays: 1,
        archiveRoot: args.archiveRoot,
        fetchedAt: args.fetchedAt,
        pageBudget,
      })

      if (result.challenged) scrapeNotes.push(`${source.handle}:challenged`)
      else if (result.privateOrSuspended) scrapeNotes.push(`${source.handle}:private-or-suspended`)
      else if (!result.ok) scrapeNotes.push(`${source.handle}:${result.reason ?? "failed"}`)

      for (const post of result.posts) {
        scraped.push({
          id: post.id,
          author: post.author,
          text: post.text,
          url: post.url,
          timestamp: post.timestamp,
          provenance: post.provenance,
          ...(post.isReply ? { isReply: true } : {}),
        })
      }
    }

    candidates = scraped

    if (candidates.length === 0 && scrapeNotes.length > 0) {
      await args.writer.writeInbox(args.runId, "fomo-narrative-sources", {
        source: "host.fomo-narrative-source-scan",
        fetchedAt: args.fetchedAt,
        trust: "untrusted-external",
        items: [{
          provenance: `${args.runId}:fomo-narrative:status`,
          text: `kind=empty handles=${[...selectedHandles].join(",")} notes=${scrapeNotes.join(",")}`,
          ts: args.fetchedAt,
          ageSec: 0,
          freshnessTier: "live",
        }],
      })
      return {
        snapshotNames: ["fomo-narrative-sources"],
        fypAuthors: [],
        discoverySightings: [],
        fcDiscoverySightings: [],
        fypPosts: [],
        fypCasts: [],
        postCount: 0,
        skipAgent: true,
        collectionKind: "host-only",
        collectionStatus: "fomo-narrative-empty",
      }
    }
  }

  const live = candidates.filter((post) => {
    if (!selectedHandles.has(post.author.toLowerCase())) return false
    const fields = freshnessFromIso(post.timestamp, args.fetchedAt)
    return Boolean(fields.ok && fields.ageSec !== undefined && isLiveEligible(fields.ageSec))
  })

  if (live.length === 0) {
    await args.writer.writeInbox(args.runId, "fomo-narrative-sources", {
      source: "host.fomo-narrative-source-scan",
      fetchedAt: args.fetchedAt,
      trust: "untrusted-external",
      items: [{
        provenance: `${args.runId}:fomo-narrative:empty`,
        text: `kind=empty handles=${[...selectedHandles].join(",")} posts=0`,
        ts: args.fetchedAt,
        ageSec: 0,
        freshnessTier: "live",
      }],
    })
    return {
      snapshotNames: ["fomo-narrative-sources"],
      fypAuthors: [],
      discoverySightings: [],
      fcDiscoverySightings: [],
      fypPosts: [],
      fypCasts: [],
      postCount: 0,
      skipAgent: true,
      collectionKind: "host-only",
      collectionStatus: "fomo-narrative-empty",
    }
  }

  await args.writer.writeInbox(args.runId, "fomo-narrative-sources", {
    source: "host.fomo-narrative-source-scan",
    fetchedAt: args.fetchedAt,
    trust: "untrusted-external",
    items: live.map((post) => {
      const fields = freshnessFromIso(post.timestamp, args.fetchedAt)
      return {
        provenance: post.provenance ?? `twitter:@${post.author}`,
        text: [
          "purpose=narrative-probation-live",
          `postId=${post.id}`,
          `author=${post.author}`,
          post.text.slice(0, 4_000),
        ].join(" "),
        ts: fields.ts ?? args.fetchedAt,
        ageSec: fields.ageSec ?? 0,
        freshnessTier: fields.freshnessTier ?? "live",
        url: post.url,
        dedupeKey: post.id,
      }
    }),
  })

  return {
    snapshotNames: ["fomo-narrative-sources"],
    fypAuthors: [],
    discoverySightings: [],
    fcDiscoverySightings: [],
    fypPosts: [],
    fypCasts: [],
    postCount: live.length,
    skipAgent: true,
    collectionKind: "host-only",
    collectionStatus: "fomo-narrative-scanned",
  }
}
