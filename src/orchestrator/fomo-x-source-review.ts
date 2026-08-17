import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { SnapshotWriter } from "../lib/snapshot.js"
import { loadConfig } from "../lib/config.js"
import { StateStore } from "../lib/state.js"
import { writeAtomicFile } from "../lib/fs-atomic.js"
import { freshnessFromIso, pointInTimeSnapshot } from "../collectors/fomo/freshness.js"
import { scrapeProfileHistory } from "../collectors/twitter/profile-history.js"
import {
  applyClassificationResult,
  markClassifying,
  nextPendingNomination,
} from "../sources/x-nominations.js"
import type { CollectionSummary } from "./collect.js"
import type { TwitterPost } from "../collectors/twitter/session.js"

export type InjectedHistoryPost = Readonly<{
  id: string
  author: string
  text: string
  url: string
  timestamp: string
  provenance?: string
  isReply?: boolean
}>

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
    source: "host.fomo-x-source-review",
    fetchedAt: args.fetchedAt,
    trust: "untrusted-external",
    items: [{
      provenance: `${args.runId}:fomo-x:${reason}`,
      text: `kind=skip reason=${reason}`,
      ts: args.fetchedAt,
      ageSec: 0,
      freshnessTier: "live",
    }],
  })
  return ["collection-status"]
}

function reviewRunsPath(archiveRoot: string, day: string): string {
  return join(archiveRoot, "provider-usage", "twitter", "fomo-source-review-runs", `${day}.json`)
}

async function loadReviewCount(archiveRoot: string, day: string): Promise<number> {
  const path = reviewRunsPath(archiveRoot, day)
  if (!existsSync(path)) return 0
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { reviews?: number }
    return Number(raw.reviews ?? 0)
  } catch {
    return 0
  }
}

async function saveReviewCount(archiveRoot: string, day: string, reviews: number): Promise<void> {
  await writeAtomicFile(
    reviewRunsPath(archiveRoot, day),
    `${JSON.stringify({ schema: 1, day, reviews }, null, 2)}\n`,
  )
}

function distinctUtcDays(posts: readonly InjectedHistoryPost[]): number {
  return new Set(posts.map((post) => post.timestamp.slice(0, 10)).filter(Boolean)).size
}

function toInjected(posts: readonly InjectedHistoryPost[] | readonly TwitterPost[]): InjectedHistoryPost[] {
  return posts.map((post) => ({
    id: post.id,
    author: post.author,
    text: post.text,
    url: post.url,
    timestamp: post.timestamp,
    provenance: "provenance" in post && post.provenance
      ? post.provenance
      : `twitter:@${post.author}`,
    ...("isReply" in post && post.isReply ? { isReply: true } : {}),
  }))
}

function classifySkipStatus(
  attempts: number,
  maxAttempts: number,
): "insufficient-history" | "unreviewable" {
  return attempts >= maxAttempts ? "unreviewable" : "insufficient-history"
}

/**
 * Host collect for one pending Fomo→X nomination. Prefer injected `posts`/`history`
 * over Playwright so unit tests never launch a browser. X history only — FOMO
 * buys stay on the FOMO follow track.
 */
export async function collectFomoXSourceReview(args: Readonly<{
  runId: string
  writer: SnapshotWriter
  fetchedAt: string
  agentRoot: string
  archiveRoot: string
  posts?: readonly InjectedHistoryPost[]
  history?: readonly InjectedHistoryPost[]
}>): Promise<CollectionSummary> {
  const config = loadConfig()
  if (!config.fomo.enabled || !config.fomo.x_source_review.enabled) {
    return skipSummary(await writeSkip(args, "fomo-disabled"), "fomo-disabled")
  }

  const day = args.fetchedAt.slice(0, 10)
  const used = await loadReviewCount(args.archiveRoot, day)
  if (used >= config.fomo.x_source_review.max_reviews_per_day) {
    return skipSummary(await writeSkip(args, "fomo-x-daily-cap"), "fomo-x-daily-cap")
  }

  const state = new StateStore(join(args.agentRoot, "state"))
  let nominations = state.loadXSourceNominations()
  const pending = nextPendingNomination(nominations, args.fetchedAt)
  if (!pending) {
    return skipSummary(await writeSkip(args, "fomo-x-no-pending"), "fomo-x-no-pending")
  }

  nominations = markClassifying(nominations, pending.nominationId)
  await state.saveXSourceNominations(nominations)

  const injected = args.posts ?? args.history
  let posts: InjectedHistoryPost[]
  if (injected) {
    posts = toInjected(injected)
  } else {
    const scraped = await scrapeProfileHistory({
      handle: pending.xHandle,
      maxPages: config.fomo.x_source_review.max_pages_per_review,
      maxPosts: config.fomo.x_source_review.max_posts_per_review,
      lookbackDays: config.fomo.x_source_review.lookback_days,
      archiveRoot: args.archiveRoot,
      fetchedAt: args.fetchedAt,
      nominationId: pending.nominationId,
      pageBudget: config.fomo.x_source_review.daily_history_page_budget,
    })

    const attempts = nominations.nominations.find((n) => n.nominationId === pending.nominationId)?.attempts
      ?? 1

    if (scraped.privateOrSuspended) {
      nominations = applyClassificationResult(nominations, {
        nominationId: pending.nominationId,
        status: "unreviewable",
      })
      await state.saveXSourceNominations(nominations)
      return skipSummary(
        await writeSkip(args, "fomo-x-private-or-suspended"),
        "fomo-x-private-or-suspended",
      )
    }

    if (scraped.challenged || !scraped.ok) {
      const status = classifySkipStatus(attempts, config.fomo.x_source_review.max_attempts)
      nominations = applyClassificationResult(nominations, {
        nominationId: pending.nominationId,
        status,
        ...(status === "insufficient-history"
          ? {
            reviewAfter: new Date(
              Date.parse(args.fetchedAt) + config.fomo.x_source_review.retry_after_hours * 3_600_000,
            ).toISOString(),
          }
          : {}),
      })
      await state.saveXSourceNominations(nominations)
      const reason = scraped.challenged ? "fomo-x-challenged" : "fomo-x-history-failed"
      return skipSummary(await writeSkip(args, reason), reason)
    }

    posts = toInjected(scraped.posts)
  }

  const lookbackMs = config.fomo.x_source_review.lookback_days * 86_400_000
  const fetchedMs = Date.parse(args.fetchedAt)
  const eligible = posts
    .filter((post) => {
      const ts = Date.parse(post.timestamp)
      if (!Number.isFinite(ts)) return false
      if (ts > fetchedMs) return false
      return fetchedMs - ts <= lookbackMs
    })
    .slice(0, config.fomo.x_source_review.max_posts_per_review)

  if (
    eligible.length < config.fomo.x_source_review.min_posts
    || distinctUtcDays(eligible) < config.fomo.x_source_review.min_active_days
  ) {
    const attempts = (nominations.nominations.find((n) => n.nominationId === pending.nominationId)?.attempts
      ?? 1)
    const status = attempts >= config.fomo.x_source_review.max_attempts
      ? "unreviewable" as const
      : "insufficient-history" as const
    nominations = applyClassificationResult(nominations, {
      nominationId: pending.nominationId,
      status,
      ...(status === "insufficient-history"
        ? {
          reviewAfter: new Date(
            Date.parse(args.fetchedAt) + config.fomo.x_source_review.retry_after_hours * 3_600_000,
          ).toISOString(),
        }
        : {}),
    })
    await state.saveXSourceNominations(nominations)
    return skipSummary(
      await writeSkip(args, `fomo-x-${status}`),
      `fomo-x-${status}`,
    )
  }

  const sealedIds = eligible.map((post) => post.id)
  await args.writer.writeInbox(args.runId, "x-source-manifest", {
    source: "host.fomo-x-source-review",
    fetchedAt: args.fetchedAt,
    trust: "untrusted-external",
    items: [{
      provenance: `${args.runId}:fomo-x:manifest:${pending.nominationId}`,
      text: [
        `nominationId=${pending.nominationId}`,
        `xHandle=${pending.xHandle}`,
        `fomoHandle=${pending.fomoHandle}`,
        `matchBasis=${pending.matchBasis}`,
        `sealedPostIds=${sealedIds.join(",")}`,
        `postCount=${sealedIds.length}`,
        `activeDays=${distinctUtcDays(eligible)}`,
      ].join(" "),
      ts: args.fetchedAt,
      ageSec: 0,
      freshnessTier: "live",
      dedupeKey: createHash("sha256").update(sealedIds.join(",")).digest("hex").slice(0, 32),
    }],
  })

  await args.writer.writeInbox(args.runId, "x-source-history", {
    source: "host.fomo-x-source-review.historical",
    fetchedAt: args.fetchedAt,
    trust: "untrusted-external",
    items: eligible.map((post) => {
      const fields = freshnessFromIso(post.timestamp, args.fetchedAt)
      const snap = fields.ok && fields.ts && fields.ageSec !== undefined && fields.freshnessTier
        ? { ts: fields.ts, ageSec: fields.ageSec, freshnessTier: fields.freshnessTier }
        : pointInTimeSnapshot(post.timestamp, args.fetchedAt)
      return {
        provenance: post.provenance ?? `twitter:@${post.author}`,
        text: [
          "purpose=historical-source-evaluation",
          `postId=${post.id}`,
          `author=${post.author}`,
          ...(post.isReply ? ["reply=true"] : []),
          post.text.slice(0, 4_000),
        ].join(" "),
        ts: snap.ts,
        ageSec: snap.ageSec,
        freshnessTier: snap.freshnessTier,
        url: post.url,
        dedupeKey: post.id,
      }
    }),
  })

  await saveReviewCount(args.archiveRoot, day, used + 1)

  return {
    snapshotNames: ["x-source-manifest", "x-source-history"],
    fypAuthors: [],
    discoverySightings: [],
    fcDiscoverySightings: [],
    fypPosts: [],
    fypCasts: [],
    postCount: eligible.length,
    skipAgent: false,
    collectionKind: "external",
    collectionStatus: "fomo-x-ready",
  }
}
