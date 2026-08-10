import type { SnapshotWriter } from "../lib/snapshot.js"
import { loadConfig, loadEnvSecrets } from "../lib/config.js"
import {
  scrapeConfiguredTwitter,
  type TwitterScrapeBundle,
} from "../collectors/twitter/scrape.js"
import {
  scrapeConfiguredFarcaster,
  type FarcasterFeedAssessment,
  buildFarcasterCollectionReceipt,
  castAgeSec,
  freshnessTierForAge,
  summarizeFarcasterAssessments,
} from "../collectors/farcaster/scrape.js"
import {
  buildSignerGateReceipt,
  probeFarcasterSigner,
} from "../collectors/farcaster/signer.js"
import type { FcDiscoveryOrigin, SourceDiscoveryOrigin } from "../contracts/schemas.js"
import { getJob, type JobName } from "./jobs.js"
import { collectChartSweep } from "./chart-collect.js"
import { collectNarrativeScan } from "./narrative-collect.js"
import { collectWatchlistScan } from "./watchlist-collect.js"
import { StateStore } from "../lib/state.js"
import { desiredFollowFids } from "../sources/fc-lifecycle.js"
import { getChain } from "../lib/chains.js"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { SNAPSHOT_MAX_ITEMS, type CanonicalIdentity } from "../contracts/schemas.js"
import {
  collectResearchDossier,
  resolveResearchSubject,
} from "./research-collect.js"
import {
  capEnvelopeItems,
  capManifestLines,
  collectReview,
  listPendingAlphaPaths,
} from "./review-collect.js"
import { writeXFypEligibleSnapshot } from "./x-fyp-eligible.js"
import { collectFomoTraderSync } from "./fomo-trader-collect.js"
import { collectFomoSignalScan } from "./fomo-signal-collect.js"
import { collectDiscordWalletSignalScan } from "./discord-wallet-signal-collect.js"
import { collectFomoXSourceReview } from "./fomo-x-source-review.js"
import { collectFomoNarrativeSourceScan } from "./fomo-narrative-source-scan.js"
import { runNarrativeSourceReview } from "./narrative-source-review.js"
import { sanitizePathSegment } from "../lib/snapshot.js"
import { sha256Bytes } from "../lib/fs-atomic.js"
import {
  hostAckNoThesisAlphaMessages,
  type HostAlphaAckResult,
} from "./alpha.js"

export type DiscoverySighting = Readonly<{
  handle: string
  origin: SourceDiscoveryOrigin
}>

export type FcDiscoverySighting = Readonly<{
  handle: string
  fid: number
  origin: FcDiscoveryOrigin
}>

export type CollectionSummary = Readonly<{
  snapshotNames: readonly string[]
  fypAuthors: readonly string[]
  discoverySightings: readonly DiscoverySighting[]
  fcDiscoverySightings: readonly FcDiscoverySighting[]
  fypPosts: readonly Readonly<{
    id: string
    author: string
    text: string
    url: string
    timestamp: string
  }>[]
  fypCasts: readonly Readonly<{
    hash: string
    author: string
    authorFid: number
    text: string
    url?: string
    timestamp: string
  }>[]
  postCount: number
  skipAgent?: boolean
  collectionStatus?: string
  collectionKind?: "external" | "host-only" | "unavailable"
  marketBlind?: boolean
  marketBlindReason?: string
  researchIdentity?: CanonicalIdentity
  researchResolution?: string
  researchSecurityHardFail?: boolean
  /** Alpha-queue depth at list-scan collect time (path count before manifest cap) */
  alphaPendingCount?: number
  /** Paths omitted from the capped manifest (`truncated=N`); 0 when none */
  alphaManifestTruncated?: number
  /** Posts/casts omitted from capped twitter/farcaster/fyp snapshots; 0 when none */
  snapshotItemsTruncated?: number
  /** Paths still needing agent digest after host no-thesis ack */
  agentAlphaPathCount?: number
  /** Host-written digest entries for no-thesis acks (merged before purge) */
  hostAlphaAckEntries?: readonly import("../contracts/schemas.js").AlphaDigestEntry[]
  /** Curated social evidence grade — narrative-scan only (ADR 042) */
  narrativeEvidenceQuality?: import("./narrative-evidence-gate.js").NarrativeEvidenceQuality
}>

const EMPTY_SUMMARY: CollectionSummary = {
  snapshotNames: [],
  fypAuthors: [],
  discoverySightings: [],
  fcDiscoverySightings: [],
  fypPosts: [],
  fypCasts: [],
  postCount: 0,
}

export async function collectForJob(args: Readonly<{
  job: string
  runId: string
  writer: SnapshotWriter
  fetchedAt: string
  agentRoot: string
  archiveRoot: string
  researchSubject?: Readonly<{
    subject: string
    queueId?: string
    chain?: string
    tokenAddress?: string
  }>
  fetcher?: typeof fetch
  /** Injected scrape results for streaming list-scan target passes */
  listScanOverride?: Readonly<{
    bundles: readonly TwitterScrapeBundle[]
    includeAlphaManifest?: boolean
  }>
  /** Relative alpha-queue paths for telegram-alpha (path-only inbox) */
  telegramAlphaPaths?: readonly string[]
}>): Promise<CollectionSummary> {
  const job = getJob(args.job).name

  switch (job) {
    case "list-scan":
      return collectListScan(args)
    case "telegram-alpha":
      return collectTelegramAlpha(args)
    case "farcaster-scan":
      return collectFarcaster(args)
    case "chart-sweep":
      return mapChart(await collectChartSweep({
        runId: args.runId,
        writer: args.writer,
        fetchedAt: args.fetchedAt,
        agentRoot: args.agentRoot,
        archiveRoot: args.archiveRoot,
        ...(args.fetcher ? { fetcher: args.fetcher } : {}),
      }))
    case "narrative-scan":
      return mapNarrative(await collectNarrativeScan({
        runId: args.runId,
        writer: args.writer,
        fetchedAt: args.fetchedAt,
        archiveRoot: args.archiveRoot,
        farcasterEnabled: loadConfig().farcaster.enabled,
        evidenceQuality: loadConfig().narratives.evidence_quality,
      }))
    case "research":
      return collectResearch(args)
    case "watchlist-scan":
      return mapWatchlist(await collectWatchlistScan({
        runId: args.runId,
        writer: args.writer,
        fetchedAt: args.fetchedAt,
        agentRoot: args.agentRoot,
        archiveRoot: args.archiveRoot,
        ...(args.fetcher ? { fetcher: args.fetcher } : {}),
      }))
    case "source-list-review":
    case "fc-source-review":
    case "audit":
    case "outcomes-settle":
    case "delivery-retry":
    case "telegram-digest":
    case "wallet-review":
    case "wallet-runner-discovery":
    case "harness-improve":
    case "harness-meta-improve":
    case "incident-remediate":
    case "incident-remediate-weekly":
    case "recover":
      return collectHostOnly(args, job)
    case "review":
      return mapReview(await collectReview({
        runId: args.runId,
        writer: args.writer,
        fetchedAt: args.fetchedAt,
        agentRoot: args.agentRoot,
        archiveRoot: args.archiveRoot,
        ...(args.fetcher ? { fetcher: args.fetcher } : {}),
      }))
    case "wallet-discovery":
    case "wallet-scan-solana":
    case "wallet-scan-evm":
      return collectWalletEvidence(args, job)
    case "fomo-trader-sync":
      return collectFomoTraderSync({
        runId: args.runId,
        writer: args.writer,
        fetchedAt: args.fetchedAt,
        agentRoot: args.agentRoot,
        archiveRoot: args.archiveRoot,
        ...(args.fetcher ? { fetcher: args.fetcher } : {}),
      })
    case "fomo-signal-scan":
      return collectFomoSignalScan({
        runId: args.runId,
        writer: args.writer,
        fetchedAt: args.fetchedAt,
        agentRoot: args.agentRoot,
        archiveRoot: args.archiveRoot,
        ...(args.fetcher ? { fetcher: args.fetcher } : {}),
      })
    case "discord-wallet-signal-scan":
      return collectDiscordWalletSignalScan({
        runId: args.runId,
        writer: args.writer,
        fetchedAt: args.fetchedAt,
        agentRoot: args.agentRoot,
        archiveRoot: args.archiveRoot,
        ...(args.fetcher ? { fetcher: args.fetcher } : {}),
      })
    case "fomo-x-source-review":
      return collectFomoXSourceReview({
        runId: args.runId,
        writer: args.writer,
        fetchedAt: args.fetchedAt,
        agentRoot: args.agentRoot,
        archiveRoot: args.archiveRoot,
      })
    case "fomo-narrative-source-scan":
      return collectFomoNarrativeSourceScan({
        runId: args.runId,
        writer: args.writer,
        fetchedAt: args.fetchedAt,
        agentRoot: args.agentRoot,
        archiveRoot: args.archiveRoot,
      })
    case "narrative-source-review":
      return collectNarrativeSourceReviewHost(args)
    default: {
      const _exhaustive: never = job
      throw new Error(`Unhandled job collection policy: ${String(_exhaustive)}`)
    }
  }
}

async function collectWalletEvidence(
  args: Readonly<{
    runId: string
    writer: SnapshotWriter
    fetchedAt: string
    agentRoot: string
    archiveRoot: string
  }>,
  job: Extract<JobName, "wallet-discovery" | "wallet-scan-solana" | "wallet-scan-evm">,
): Promise<CollectionSummary> {
  const state = new StateStore(join(args.agentRoot, "state"))
  const wallets = state.loadWallets()
  const watchlist = state.loadWatchlist()
  const trackingSubjects = watchlist.entries.filter((entry) => (
    entry.status === "tracking" || entry.status === "watching"
  ))
  const eligibleWallets = wallets.wallets.filter((wallet) => {
    if (!["candidate", "tracking-probation", "tracking"].includes(wallet.status)) return false
    const tracking = getChain(wallet.chain)?.walletTracking
    return job === "wallet-scan-solana"
      ? tracking === "helius"
      : job === "wallet-scan-evm"
        ? tracking === "infura" || tracking === "robinhood-public"
        : true
  })
  const skipReason = job === "wallet-discovery"
    ? trackingSubjects.length === 0 ? "no-active-watchlist-subjects" : undefined
    : eligibleWallets.length === 0
      ? job === "wallet-scan-solana"
        ? "no-eligible-solana-wallets"
        : "no-eligible-evm-wallets"
      : undefined

  if (skipReason) {
    await args.writer.writeInbox(args.runId, "collection-status", {
      source: "host.wallet-evidence",
      fetchedAt: args.fetchedAt,
      trust: "untrusted-external",
      items: [{
        provenance: `${args.runId}:wallet-evidence-status`,
        text: `job=${job} status=skipped reason=${skipReason}`,
        ts: args.fetchedAt,
        ageSec: 0,
        freshnessTier: "live",
      }],
    })
    return {
      ...EMPTY_SUMMARY,
      snapshotNames: ["collection-status"],
      postCount: 1,
      skipAgent: true,
      collectionStatus: "skipped",
      collectionKind: "host-only",
    }
  }

  const evidence = {
    schema: 1,
    job,
    capturedAt: args.fetchedAt,
    watchlist: trackingSubjects.map((entry) => ({
      chain: entry.identity.chain,
      tokenAddress: entry.identity.tokenAddress,
      status: entry.status,
    })),
    wallets: wallets.wallets,
    cursors: wallets.cursors,
    eligibleWalletIds: eligibleWallets.map((wallet) => wallet.walletId),
    recentOutcomes: readRecentWalletOutcomes(args.archiveRoot),
  }
  const text = JSON.stringify(evidence)
  await args.writer.writeInbox(args.runId, `wallet-evidence-${job}`, {
    source: "host.wallet-evidence",
    fetchedAt: args.fetchedAt,
    trust: "untrusted-external",
    items: [{
      provenance: `${args.runId}:wallet-evidence-state`,
      text: text.length <= 20_000
        ? text
        : JSON.stringify({
          ...evidence,
          wallets: wallets.wallets.slice(0, 3),
          cursors: wallets.cursors.slice(0, 3),
          recentOutcomes: evidence.recentOutcomes.slice(0, 3),
          truncated: true,
        }),
      ts: args.fetchedAt,
      ageSec: 0,
      freshnessTier: "live",
    }],
  })
  return {
    ...EMPTY_SUMMARY,
    snapshotNames: [`wallet-evidence-${job}`],
    postCount: 1,
    collectionStatus: "completed",
    collectionKind: "host-only",
  }
}

function readRecentWalletOutcomes(archiveRoot: string): unknown[] {
  const outcomesDir = join(archiveRoot, "outcomes")
  if (!existsSync(outcomesDir)) return []
  const outcomes: unknown[] = []
  for (const name of readdirSync(outcomesDir)
    .filter((entry) => entry.startsWith("wallet-buy-") && entry.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, 5)) {
    try {
      const value = JSON.parse(readFileSync(join(outcomesDir, name), "utf8")) as {
        outcomes?: unknown[]
      }
      if (Array.isArray(value.outcomes)) outcomes.push(...value.outcomes.slice(0, 50 - outcomes.length))
      if (outcomes.length >= 50) break
    } catch {
      continue
    }
  }
  return outcomes
}

function mapChart(result: Awaited<ReturnType<typeof collectChartSweep>>): CollectionSummary {
  return {
    ...EMPTY_SUMMARY,
    snapshotNames: result.snapshotNames,
    postCount: result.postCount,
    skipAgent: result.skipAgent,
    collectionStatus: result.collectionStatus,
    collectionKind: "external",
  }
}

function mapNarrative(result: Awaited<ReturnType<typeof collectNarrativeScan>>): CollectionSummary {
  return {
    ...EMPTY_SUMMARY,
    snapshotNames: result.snapshotNames,
    postCount: result.postCount,
    skipAgent: result.skipAgent,
    collectionStatus: result.collectionStatus,
    collectionKind: "external",
    marketBlind: result.marketBlind,
    ...(result.marketBlindReason ? { marketBlindReason: result.marketBlindReason } : {}),
    ...(result.evidenceQuality ? { narrativeEvidenceQuality: result.evidenceQuality } : {}),
  }
}

function mapWatchlist(result: Awaited<ReturnType<typeof collectWatchlistScan>>): CollectionSummary {
  return {
    ...EMPTY_SUMMARY,
    snapshotNames: result.snapshotNames,
    postCount: result.postCount,
    skipAgent: result.skipAgent,
    collectionStatus: result.collectionStatus,
    collectionKind: "external",
  }
}

function mapReview(result: Awaited<ReturnType<typeof collectReview>>): CollectionSummary {
  return {
    ...EMPTY_SUMMARY,
    snapshotNames: result.snapshotNames,
    postCount: result.postCount,
    skipAgent: result.skipAgent,
    collectionStatus: result.collectionStatus,
    collectionKind: "external",
  }
}

async function collectHostOnly(
  args: Readonly<{ runId: string; writer: SnapshotWriter; fetchedAt: string }>,
  job: JobName,
): Promise<CollectionSummary> {
  await args.writer.writeInbox(args.runId, "collection-status", {
    source: "host.collector",
    fetchedAt: args.fetchedAt,
    trust: "untrusted-external",
    items: [{
      provenance: `${args.runId}:collection-status`,
      text: `job=${job} kind=host-only`,
      ts: args.fetchedAt,
      ageSec: 0,
      freshnessTier: "live",
    }],
  })
  return {
    ...EMPTY_SUMMARY,
    snapshotNames: ["collection-status"],
    postCount: 1,
    skipAgent: true,
    collectionStatus: "host-only",
    collectionKind: "host-only",
  }
}

async function collectNarrativeSourceReviewHost(
  args: Readonly<{
    runId: string
    writer: SnapshotWriter
    fetchedAt: string
    agentRoot: string
    archiveRoot: string
  }>,
): Promise<CollectionSummary> {
  const report = await runNarrativeSourceReview({
    agentRoot: args.agentRoot,
    nowIso: args.fetchedAt,
    runId: args.runId,
    archiveRoot: args.archiveRoot,
  })
  await args.writer.writeInbox(args.runId, "collection-status", {
    source: "host.narrative-source-review",
    fetchedAt: args.fetchedAt,
    trust: "untrusted-external",
    items: [{
      provenance: `${args.runId}:narrative-source-review`,
      text: [
        `kind=review ok=${report.ok} reason=${report.reason}`,
        `promoted=${report.promoted} demoted=${report.demoted}`,
        `followed=${report.followed} unfollowed=${report.unfollowed}`,
        report.followSkippedReason ? `followSkipped=${report.followSkippedReason}` : "",
      ].filter(Boolean).join(" "),
      ts: args.fetchedAt,
      ageSec: 0,
      freshnessTier: "live",
    }],
  })
  return {
    ...EMPTY_SUMMARY,
    snapshotNames: ["collection-status"],
    postCount: 1,
    skipAgent: true,
    collectionStatus: report.reason,
    collectionKind: "host-only",
  }
}

async function collectUnavailable(
  args: Readonly<{ runId: string; writer: SnapshotWriter; fetchedAt: string }>,
  job: JobName,
  capability: string,
): Promise<CollectionSummary> {
  await args.writer.writeInbox(args.runId, "collection-status", {
    source: "host.collector",
    fetchedAt: args.fetchedAt,
    trust: "untrusted-external",
    items: [{
      provenance: `${args.runId}:collection-status`,
      text: `job=${job} kind=unavailable capability=${capability}`,
      ts: args.fetchedAt,
      ageSec: 0,
      freshnessTier: "live",
    }],
  })
  return {
    ...EMPTY_SUMMARY,
    snapshotNames: ["collection-status"],
    postCount: 1,
    skipAgent: true,
    collectionStatus: "unavailable",
    collectionKind: "unavailable",
  }
}

async function collectResearch(args: Readonly<{
  runId: string
  writer: SnapshotWriter
  fetchedAt: string
  archiveRoot?: string
  researchSubject?: Readonly<{
    subject: string
    queueId?: string
    chain?: string
    tokenAddress?: string
  }>
  fetcher?: typeof fetch
}>): Promise<CollectionSummary> {
  if (!args.researchSubject) {
    await writeResearchStatus(args, "skipped", "no-subject")
    return {
      ...EMPTY_SUMMARY,
      snapshotNames: ["collection-status"],
      postCount: 1,
      skipAgent: true,
      collectionStatus: "skipped",
      collectionKind: "external",
      researchResolution: "skipped",
    }
  }

  const lines = [
    `job=research`,
    `subject=${args.researchSubject.subject}`,
    args.researchSubject?.queueId ? `queueId=${args.researchSubject.queueId}` : "",
    args.researchSubject?.chain ? `chain=${args.researchSubject.chain}` : "",
    args.researchSubject?.tokenAddress
      ? `tokenAddress=${args.researchSubject.tokenAddress}`
      : "",
  ].filter(Boolean)
  const resolved = await resolveResearchSubject({
    subject: args.researchSubject.subject,
    ...(args.researchSubject.chain
      ? { chainHint: args.researchSubject.chain as CanonicalIdentity["chain"] }
      : {}),
    ...(args.researchSubject.tokenAddress ? { tokenHint: args.researchSubject.tokenAddress } : {}),
  }, args.fetcher ?? fetch)
  if (resolved.status !== "resolved") {
    const status = resolved.status
    await writeResearchMeta(args, [...lines, `resolution=${status}`])
    await writeResearchStatus(
      args,
      status,
      resolved.status === "unsupported-chain"
        ? `chain=${resolved.chain}`
        : `reason=${status}`,
    )
    return {
      ...EMPTY_SUMMARY,
      snapshotNames: ["meta", "collection-status"],
      postCount: 2,
      skipAgent: true,
      collectionStatus: status,
      collectionKind: "external",
      researchResolution: status,
    }
  }

  const dossier = await collectResearchDossier({
    writer: args.writer,
    runId: args.runId,
    subject: args.researchSubject.subject,
    identity: resolved.identity,
    fetchedAt: args.fetchedAt,
    pairs: resolved.pairs,
    ...(args.archiveRoot ? { archiveRoot: args.archiveRoot } : {}),
    ...(args.researchSubject.queueId ? { queueId: args.researchSubject.queueId } : {}),
    ...(args.fetcher ? { fetcher: args.fetcher } : {}),
  })
  return {
    ...EMPTY_SUMMARY,
    snapshotNames: dossier.snapshotNames,
    postCount: dossier.snapshotNames.length,
    collectionStatus: "resolved",
    collectionKind: "external",
    researchIdentity: resolved.identity,
    researchResolution: "resolved",
    researchSecurityHardFail: dossier.security.hardFail || dossier.security.status === "hard-fail",
  }
}

async function writeResearchMeta(
  args: Readonly<{ runId: string; writer: SnapshotWriter; fetchedAt: string }>,
  lines: readonly string[],
): Promise<void> {
  await args.writer.writeInbox(args.runId, "meta", {
    source: "host.collector",
    fetchedAt: args.fetchedAt,
    trust: "untrusted-external",
    items: [{
      provenance: `${args.runId}:meta`,
      text: lines.join(" "),
      ts: args.fetchedAt,
      ageSec: 0,
      freshnessTier: "live",
    }],
  })
}

async function writeResearchStatus(
  args: Readonly<{ runId: string; writer: SnapshotWriter; fetchedAt: string }>,
  status: string,
  detail: string,
): Promise<void> {
  await args.writer.writeInbox(args.runId, "collection-status", {
    source: "host.collector",
    fetchedAt: args.fetchedAt,
    trust: "untrusted-external",
    items: [{
      provenance: `${args.runId}:collection-status`,
      text: `job=research status=${status} ${detail}`,
      ts: args.fetchedAt,
      ageSec: 0,
      freshnessTier: "live",
    }],
  })
}

/** Path-only inbox snapshot so list-scan can digest alpha-queue (INV-Q1). */
export async function writeListScanAlphaManifest(args: Readonly<{
  runId: string
  writer: SnapshotWriter
  fetchedAt: string
  agentRoot: string
  /** When set, write these paths instead of listing the full queue */
  paths?: readonly string[]
}>): Promise<Readonly<{
  snapshotName: "list-scan-alpha-manifest"
  pendingCount: number
  truncatedBy: number
  paths: readonly string[]
}>> {
  const pendingAlphaPaths = args.paths
    ? [...args.paths]
    : listPendingAlphaPaths(args.agentRoot)
  const alphaLines = capManifestLines(
    pendingAlphaPaths.map((path) => `path=${path}`),
  )
  const truncatedMarker = alphaLines.find((line) => line.startsWith("truncated="))
  const truncatedBy = truncatedMarker
    ? Number.parseInt(truncatedMarker.slice("truncated=".length), 10) || 0
    : 0
  const cappedPaths = pendingAlphaPaths.slice(
    0,
    Math.max(0, pendingAlphaPaths.length - truncatedBy),
  )
  await args.writer.writeInbox(args.runId, "list-scan-alpha-manifest", {
    source: "host.list-scan-collector",
    fetchedAt: args.fetchedAt,
    trust: "untrusted-external",
    items: (alphaLines.length > 0 ? alphaLines : ["pendingAlpha=(none)"]).map((text, index) => ({
      provenance: `${args.runId}:list-scan-alpha-manifest:${index}`,
      text,
      ts: args.fetchedAt,
      ageSec: 0,
      freshnessTier: "live" as const,
    })),
  })
  return {
    snapshotName: "list-scan-alpha-manifest",
    pendingCount: pendingAlphaPaths.length,
    truncatedBy,
    paths: cappedPaths,
  }
}

async function collectListScan(args: Readonly<{
  runId: string
  writer: SnapshotWriter
  fetchedAt: string
  agentRoot: string
  listScanOverride?: Readonly<{
    bundles: readonly TwitterScrapeBundle[]
    includeAlphaManifest?: boolean
  }>
}>): Promise<CollectionSummary> {
  const config = loadConfig()
  const bundles = args.listScanOverride?.bundles
    ?? await scrapeConfiguredTwitter(config)
  // Streaming target passes skip alpha by default (telegram-alpha owns that path)
  const shouldWriteAlpha = args.listScanOverride
    ? Boolean(args.listScanOverride.includeAlphaManifest)
    : true
  const names: string[] = []
  const fypAuthors = new Set<string>()
  const sightings: DiscoverySighting[] = []
  const seenKeys = new Set<string>()
  const fypPosts: CollectionSummary["fypPosts"][number][] = []
  let postCount = 0
  let snapshotItemsTruncated = 0

  for (const bundle of bundles) {
    if (bundle.challenged) {
      throw new Error(
        `Twitter ${bundle.target.label} needs headful re-auth: pnpm dev:cli auth twitter`,
      )
    }
    const name = sanitizeSnapshotName(bundle.target.label)
    names.push(name)
    postCount += bundle.posts.length
    const origin = originForTwitterTarget(bundle)
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
    snapshotItemsTruncated += await writeTwitterBundle(args, name, bundle)
  }

  const fypKeep = fypPosts.length > SNAPSHOT_MAX_ITEMS
    ? SNAPSHOT_MAX_ITEMS - 1
    : fypPosts.length
  const fypTruncated = Math.max(0, fypPosts.length - fypKeep)
  const summaryFypPosts = fypTruncated > 0 ? fypPosts.slice(0, fypKeep) : fypPosts
  snapshotItemsTruncated += fypTruncated

  if (summaryFypPosts.length > 0) {
    await writeXFypEligibleSnapshot({
      writer: args.writer,
      runId: args.runId,
      fetchedAt: args.fetchedAt,
      posts: summaryFypPosts,
      ...(fypTruncated > 0 ? { truncatedBy: fypTruncated } : {}),
    })
  }

  let alphaPendingCount = 0
  let alphaManifestTruncated = 0
  let agentAlphaPathCount = 0
  let hostAck: HostAlphaAckResult | undefined
  if (shouldWriteAlpha) {
    const pending = listPendingAlphaPaths(args.agentRoot)
    alphaPendingCount = pending.length
    hostAck = await hostAckNoThesisAlphaMessages({
      agentRoot: args.agentRoot,
      runId: args.runId,
      paths: pending.slice(0, 500),
    })
    agentAlphaPathCount = hostAck.needsAgentPaths.length
    const alpha = await writeListScanAlphaManifest({
      ...args,
      paths: hostAck.needsAgentPaths,
    })
    names.push(alpha.snapshotName)
    alphaManifestTruncated = alpha.truncatedBy
  }

  const skipAgent = postCount === 0 && agentAlphaPathCount === 0

  await args.writer.writeInbox(args.runId, "list-scan-collection-status", {
    source: "host.collector",
    fetchedAt: args.fetchedAt,
    trust: "untrusted-external",
    items: [{
      provenance: `${args.runId}:list-scan-collection-status`,
      text: [
        `postCount=${postCount}`,
        `alphaPending=${alphaPendingCount}`,
        `agentAlpha=${agentAlphaPathCount}`,
        `skipAgent=${skipAgent}`,
      ].join(" "),
      ts: args.fetchedAt,
      ageSec: 0,
      freshnessTier: "live" as const,
    }],
  })
  names.push("list-scan-collection-status")

  const statusParts: string[] = []
  if (shouldWriteAlpha && alphaPendingCount > 0) {
    statusParts.push(
      alphaManifestTruncated > 0
        ? `alpha-backlog:${alphaPendingCount};truncated=${alphaManifestTruncated}`
        : `alpha-pending:${alphaPendingCount}`,
    )
  }
  if (agentAlphaPathCount > 0) {
    statusParts.push(`agent-alpha:${agentAlphaPathCount}`)
  }
  if (snapshotItemsTruncated > 0) {
    statusParts.push(`posts-truncated:${snapshotItemsTruncated}`)
  }
  if (args.listScanOverride) {
    statusParts.push(`streaming-target:${bundles.map((b) => b.target.label).join(",")}`)
  }
  if (skipAgent) {
    statusParts.push("no-signal")
  }

  return {
    snapshotNames: names,
    fypAuthors: [...fypAuthors].sort(),
    discoverySightings: sightings.sort((a, b) => (
      a.origin === b.origin
        ? a.handle.localeCompare(b.handle)
        : a.origin.localeCompare(b.origin)
    )),
    fcDiscoverySightings: [],
    fypPosts: summaryFypPosts,
    fypCasts: [],
    postCount,
    collectionKind: "external",
    ...(skipAgent ? { skipAgent: true, collectionStatus: "no-signal" } : {}),
    ...(shouldWriteAlpha
      ? {
        alphaPendingCount,
        alphaManifestTruncated,
        agentAlphaPathCount,
        ...(hostAck && hostAck.hostEntries.length > 0
          ? { hostAlphaAckEntries: hostAck.hostEntries }
          : {}),
      }
      : {}),
    ...(snapshotItemsTruncated > 0 ? { snapshotItemsTruncated } : {}),
    ...(!skipAgent && statusParts.length > 0
      ? { collectionStatus: statusParts.join(";") }
      : skipAgent
        ? { collectionStatus: "no-signal" }
        : {}),
  }
}

async function collectTelegramAlpha(args: Readonly<{
  runId: string
  writer: SnapshotWriter
  fetchedAt: string
  agentRoot: string
  telegramAlphaPaths?: readonly string[]
}>): Promise<CollectionSummary> {
  const paths = args.telegramAlphaPaths ?? []
  if (paths.length === 0) {
    await args.writer.writeInbox(args.runId, "collection-status", {
      source: "host.telegram-alpha",
      fetchedAt: args.fetchedAt,
      trust: "untrusted-external",
      items: [{
        provenance: `${args.runId}:telegram-alpha-status`,
        text: "job=telegram-alpha status=skipped reason=no-paths",
        ts: args.fetchedAt,
        ageSec: 0,
        freshnessTier: "live",
      }],
    })
    return {
      ...EMPTY_SUMMARY,
      snapshotNames: ["collection-status"],
      postCount: 1,
      skipAgent: true,
      collectionStatus: "skipped",
      collectionKind: "host-only",
    }
  }

  const cappedPaths = paths.slice(0, Math.max(0, paths.length - (
    (() => {
      const lines = capManifestLines(paths.map((p) => `path=${p}`))
      const marker = lines.find((line) => line.startsWith("truncated="))
      return marker ? Number.parseInt(marker.slice("truncated=".length), 10) || 0 : 0
    })()
  )))
  const truncatedBy = Math.max(0, paths.length - cappedPaths.length)
  const snapshotNames: string[] = ["telegram-alpha-manifest"]

  // Seal message bodies so host research enqueue can see verbatim CAs/tickers
  for (const rel of cappedPaths) {
    const sealed = trySealTelegramAlphaPath({
      agentRoot: args.agentRoot,
      runId: args.runId,
      writer: args.writer,
      fetchedAt: args.fetchedAt,
      relativePath: rel,
    })
    if (!sealed) continue
    try {
      await sealed.write()
      snapshotNames.push(sealed.name)
    } catch {
      // Fail closed per path — do not invent text
    }
  }

  const hostAck = await hostAckNoThesisAlphaMessages({
    agentRoot: args.agentRoot,
    runId: args.runId,
    paths: cappedPaths,
  })
  const agentAlphaPathCount = hostAck.needsAgentPaths.length
  const agentAlphaLines = capManifestLines(hostAck.needsAgentPaths.map((path) => {
    const abs = join(args.agentRoot, path)
    if (!existsSync(abs)) return `path=${path}`
    try {
      const hash = sha256Bytes(readFileSync(abs))
      return `path=${path} contentHash=${hash}`
    } catch {
      return `path=${path}`
    }
  }))
  await args.writer.writeInbox(args.runId, "telegram-alpha-manifest", {
    source: "host.telegram-alpha",
    fetchedAt: args.fetchedAt,
    trust: "untrusted-external",
    items: (agentAlphaLines.length > 0 ? agentAlphaLines : ["pendingAlpha=(none)"]).map((text, index) => ({
      provenance: `${args.runId}:telegram-alpha-manifest:${index}`,
      text,
      ts: args.fetchedAt,
      ageSec: 0,
      freshnessTier: "live" as const,
    })),
  })

  const skipAgent = agentAlphaPathCount === 0

  return {
    ...EMPTY_SUMMARY,
    snapshotNames,
    postCount: cappedPaths.length,
    collectionKind: "external",
    alphaPendingCount: paths.length,
    alphaManifestTruncated: truncatedBy,
    agentAlphaPathCount,
    ...(hostAck.hostEntries.length > 0
      ? { hostAlphaAckEntries: hostAck.hostEntries }
      : {}),
    ...(skipAgent
      ? {
        skipAgent: true,
        collectionStatus: "host-alpha-ack-only",
      }
      : truncatedBy > 0
        ? { collectionStatus: `alpha-pending:${paths.length};truncated=${truncatedBy};agent-alpha:${agentAlphaPathCount}` }
        : { collectionStatus: `alpha-pending:${paths.length};agent-alpha:${agentAlphaPathCount}` }),
  }
}

/**
 * Parse alpha-queue/<channel>/<id>.json and prepare a sealed inbox write.
 * Returns undefined when the path is unsafe, missing, or unreadable.
 */
export function trySealTelegramAlphaPath(args: Readonly<{
  agentRoot: string
  runId: string
  writer: SnapshotWriter
  fetchedAt: string
  relativePath: string
}>): Readonly<{ name: string; write: () => Promise<void> }> | undefined {
  const match = /^alpha-queue\/([^/]+)\/([^/]+)\.json$/u.exec(args.relativePath.trim())
  if (!match) return undefined
  let channel: string
  let messageId: string
  try {
    channel = sanitizePathSegment(match[1]!)
    messageId = sanitizePathSegment(match[2]!)
  } catch {
    return undefined
  }
  const queuePath = join(args.agentRoot, "alpha-queue", channel, `${messageId}.json`)
  if (!existsSync(queuePath)) return undefined
  let raw: string
  try {
    raw = readFileSync(queuePath, "utf8")
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  const items = record["items"]
  if (!Array.isArray(items) || items.length === 0) return undefined
  const first = items[0]
  if (first === null || typeof first !== "object" || Array.isArray(first)) return undefined
  const item = first as Record<string, unknown>
  const text = item["text"]
  if (typeof text !== "string" || text.length < 1) return undefined
  const provenance = typeof item["provenance"] === "string" && item["provenance"].startsWith("telegram:")
    ? item["provenance"].slice(0, 256)
    : `telegram:${channel}`
  const ts = typeof item["ts"] === "string" ? item["ts"] : args.fetchedAt
  const url = typeof item["url"] === "string" ? item["url"] : undefined
  const name = `telegram-alpha-${channel}-${messageId}`
  return {
    name,
    write: async () => {
      await args.writer.writeInbox(args.runId, name, {
        source: "telegram.preview",
        fetchedAt: args.fetchedAt,
        trust: "untrusted-external",
        items: [{
          provenance,
          text: text.slice(0, 20_000),
          ...(url ? { url } : {}),
          ts,
          ageSec: 0,
          freshnessTier: "live",
        }],
      })
    },
  }
}

async function collectFarcaster(args: Readonly<{
  runId: string
  writer: SnapshotWriter
  fetchedAt: string
  agentRoot: string
}>): Promise<CollectionSummary> {
  const config = loadConfig()
  if (!config.farcaster.enabled) {
    await args.writer.writeInbox(args.runId, "farcaster-collection-status", {
      source: "host.collector",
      fetchedAt: args.fetchedAt,
      trust: "untrusted-external",
      items: [{
        provenance: `${args.runId}:fc-status`,
        text: "status=disabled reason=farcaster.enabled=false",
        ts: args.fetchedAt,
        ageSec: 0,
        freshnessTier: "live",
      }],
    })
    return {
      ...EMPTY_SUMMARY,
      snapshotNames: ["farcaster-collection-status"],
      postCount: 1,
      skipAgent: true,
      collectionStatus: "disabled",
      collectionKind: "unavailable",
    }
  }

  const secrets = loadEnvSecrets()
  if (!secrets.neynarApiKey) throw new Error("NEYNAR_API_KEY is required for farcaster-scan")
  if (config.farcaster.bot_fid === undefined) {
    await args.writer.writeInbox(args.runId, "farcaster-collection-status", {
      source: "host.collector",
      fetchedAt: args.fetchedAt,
      trust: "untrusted-external",
      items: [{
        provenance: `${args.runId}:fc-status`,
        text: "status=missing-bot-fid",
        ts: args.fetchedAt,
        ageSec: 0,
        freshnessTier: "live",
      }],
    })
    return {
      ...EMPTY_SUMMARY,
      snapshotNames: ["farcaster-collection-status"],
      postCount: 1,
      skipAgent: true,
      collectionStatus: "missing-bot-fid",
      collectionKind: "unavailable",
    }
  }

  const bundles = await scrapeConfiguredFarcaster(config, { apiKey: secrets.neynarApiKey })
  const signerProbe = await probeFarcasterSigner({
    apiKey: secrets.neynarApiKey,
    nowIso: args.fetchedAt,
  })
  const signerGate = buildSignerGateReceipt(signerProbe)
  const names: string[] = []
  const fypAuthors = new Set<string>()
  const sightings: FcDiscoverySighting[] = []
  const seenKeys = new Set<string>()
  const fypCasts: CollectionSummary["fypCasts"][number][] = []
  let postCount = 0
  let snapshotItemsTruncated = 0
  const assessments = bundles.map((b) => b.assessment)
  const receipt = buildFarcasterCollectionReceipt(assessments)

  for (const bundle of bundles) {
    const assessment = bundle.assessment
    const name = sanitizeSnapshotName(assessment.target.label)
    names.push(name)
    postCount += assessment.casts.length
    const origin = originForFarcasterTarget(assessment)
    if (origin) {
      for (const cast of assessment.eligibleCasts) {
        const key = `${origin}:${cast.author.toLowerCase()}`
        if (!seenKeys.has(key)) {
          seenKeys.add(key)
          sightings.push({
            handle: cast.author,
            fid: cast.authorFid,
            origin,
          })
        }
      }
    }
    // Engagement allowlist: verified live For You only — fallback/trending never authorizes likes
    if (assessment.engagementEligible && assessment.target.kind === "for_you") {
      for (const cast of assessment.eligibleCasts) {
        if (freshnessTierForAge(castAgeSec(args.fetchedAt, cast.timestamp)) !== "live") continue
        fypAuthors.add(cast.author)
        fypCasts.push({
          hash: cast.hash,
          author: cast.author,
          authorFid: cast.authorFid,
          text: cast.text,
          timestamp: cast.timestamp,
          ...(cast.url ? { url: cast.url } : {}),
        })
      }
    }
    snapshotItemsTruncated += await writeFarcasterBundle(args, name, assessment)
  }

  const store = new StateStore(join(args.agentRoot, "state"))
  let desiredManaged = 0
  try {
    desiredManaged = desiredFollowFids(store.loadFcSourceLifecycle()).length
  } catch {
    desiredManaged = 0
  }
  const followingAssessment = bundles.find((b) => b.assessment.target.kind === "following")?.assessment
  const followingCount = followingAssessment?.eligibleCasts.length ?? 0
  const followingStatus = followingAssessment
    ? (followingCount === 0 && desiredManaged === 0
      ? "healthy-empty-following"
      : followingCount === 0
        ? "empty-following-with-desired"
        : "following-populated")
    : "following-not-targeted"
  const fypAssessment = bundles.find((b) => b.assessment.target.kind === "for_you")?.assessment
  const skipAgent = receipt.skipAgent

  await args.writer.writeInbox(args.runId, "farcaster-collection-status", {
    source: "host.collector",
    fetchedAt: args.fetchedAt,
    trust: "untrusted-external",
    items: [{
      provenance: `${args.runId}:fc-status`,
      text: [
        `botFid=${config.farcaster.bot_fid}`,
        `targets=${bundles.map((b) => `${b.assessment.target.label}:${b.assessment.counts.total}`).join(",")}`,
        `eligible=${summarizeFarcasterAssessments(assessments)}`,
        `usableEvidence=${receipt.usableEvidenceCount}`,
        `fallbackUsed=${receipt.fallbackUsed}`,
        `engagementDisabled=${receipt.engagementDisabled}`,
        `desiredManagedFollows=${desiredManaged}`,
        `followingCount=${followingCount}`,
        `followingStatus=${followingStatus}`,
        `signerStatus=${signerProbe.status}`,
        `signerMutations=${signerGate.mutationsAllowed ? "allowed" : "blocked"}`,
        ...(fypAssessment?.rejected ? [`fypRejected=${fypAssessment.rejectReason}`] : []),
        ...(skipAgent ? ["skipAgent=true"] : []),
      ].join(" "),
      ts: args.fetchedAt,
      ageSec: 0,
      freshnessTier: "live",
    }],
  })
  names.push("farcaster-collection-status")

  await args.writer.writeInbox(args.runId, "farcaster-collection-receipt", {
    source: "host.collector",
    fetchedAt: args.fetchedAt,
    trust: "untrusted-external",
    items: [{
      provenance: `${args.runId}:fc-receipt`,
      text: JSON.stringify(receipt),
      ts: args.fetchedAt,
      ageSec: 0,
      freshnessTier: "live",
      dedupeKey: `${args.runId}:fc-receipt`,
    }],
  })
  names.push("farcaster-collection-receipt")

  const baseStatus = skipAgent
    ? (fypAssessment?.rejectReason
      ?? (receipt.usableEvidenceCount === 0 ? "no-usable-fc-evidence" : "fc-unusable"))
    : (receipt.engagementDisabled
      ? `analysis-only:${followingStatus}`
      : followingStatus)

  return {
    snapshotNames: names,
    fypAuthors: [...fypAuthors].sort(),
    discoverySightings: [],
    fcDiscoverySightings: sightings.sort((a, b) => (
      a.origin === b.origin
        ? a.handle.localeCompare(b.handle)
        : a.origin.localeCompare(b.origin)
    )),
    fypPosts: [],
    fypCasts,
    postCount,
    collectionKind: "external",
    ...(skipAgent ? { skipAgent: true } : {}),
    collectionStatus: snapshotItemsTruncated > 0
      ? `${baseStatus};casts-truncated:${snapshotItemsTruncated}`
      : baseStatus,
    ...(snapshotItemsTruncated > 0 ? { snapshotItemsTruncated } : {}),
  }
}

function originForTwitterTarget(bundle: TwitterScrapeBundle): SourceDiscoveryOrigin | undefined {
  if (bundle.target.kind === "home") return "fyp"
  if (bundle.target.label === "operator-list-1") return "operator-list-1"
  if (bundle.target.label === "operator-list-2") return "operator-list-2"
  return undefined
}

function originForFarcasterTarget(assessment: FarcasterFeedAssessment): FcDiscoveryOrigin | undefined {
  if (assessment.target.kind === "for_you") return "fc-fyp"
  if (assessment.target.label === "operator-channel-1") return "fc-channel-1"
  if (assessment.target.label === "operator-channel-2") return "fc-channel-2"
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
): Promise<number> {
  const fetchedMs = Date.parse(args.fetchedAt)
  const mapped = bundle.posts.map((post) => {
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
  })
  const capped = capEnvelopeItems(
    mapped,
    (truncatedBy) => ({
      provenance: `${args.runId}:twitter-${name}:truncated`,
      text: `truncated=${truncatedBy}`,
      url: "",
      ts: args.fetchedAt,
      ageSec: 0,
      freshnessTier: "live" as const,
      dedupeKey: `truncated-${truncatedBy}`,
    }),
  )
  await args.writer.writeInbox(args.runId, `twitter-${name}`, {
    source: `twitter.${bundle.target.label}`,
    fetchedAt: args.fetchedAt,
    trust: "untrusted-external",
    items: capped.items,
  })
  return capped.truncatedBy
}

async function writeFarcasterBundle(
  args: Readonly<{
    runId: string
    writer: SnapshotWriter
    fetchedAt: string
  }>,
  name: string,
  assessment: FarcasterFeedAssessment,
): Promise<number> {
  const mapped = assessment.eligibleCasts.map((cast) => {
    const ageSec = castAgeSec(args.fetchedAt, cast.timestamp)
    return {
      provenance: cast.provenance,
      text: cast.text,
      ...(cast.url ? { url: cast.url } : {}),
      ts: cast.timestamp,
      ageSec,
      freshnessTier: freshnessTierForAge(ageSec),
      dedupeKey: cast.hash,
    }
  })
  const capped = capEnvelopeItems(
    mapped,
    (truncatedBy) => ({
      provenance: `${args.runId}:farcaster-${name}:truncated`,
      text: `truncated=${truncatedBy}`,
      ts: args.fetchedAt,
      ageSec: 0,
      freshnessTier: "live" as const,
      dedupeKey: `truncated-${truncatedBy}`,
    }),
  )
  await args.writer.writeInbox(args.runId, `farcaster-${name}`, {
    source: `farcaster.${assessment.target.label}`,
    fetchedAt: args.fetchedAt,
    trust: "untrusted-external",
    items: capped.items,
  })
  return capped.truncatedBy
}

function sanitizeSnapshotName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 64)
}
