import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  ensureArchive,
  runArchiveDir,
  type ArchiveLayout,
} from "../lib/archive.js"
import type { SnapshotWriter } from "../lib/snapshot.js"
import type { SnapshotEnvelope } from "../contracts/schemas.js"
import { RunManifestSchema } from "../contracts/schemas.js"
import { fetchMarketAttentionForNarrative } from "../collectors/market/providers.js"
import type { FetchLike } from "../collectors/market/geckoterminal.js"
import { loadJournalForScan } from "./journal-store.js"
import { curateSocialEvidence } from "./social-evidence.js"
import {
  assessNarrativeEvidenceQuality,
  type NarrativeEvidenceQuality,
} from "./narrative-evidence-gate.js"

const LIVE_SEC = 6 * 3_600
const STALE_VISIBLE_SEC = 24 * 3_600
const MAX_ITEMS = 200
const MAX_CANDIDATE_RUNS = 24

export type NarrativeCollectResult = Readonly<{
  snapshotNames: readonly string[]
  postCount: number
  skipAgent: boolean
  collectionStatus: "completed" | "degraded" | "skipped"
  usableEvidence: boolean
  marketBlind: boolean
  marketBlindReason?: string
  selectedRuns: Readonly<{
    listScan?: string
    farcasterScan?: string
    fomoNarrativeScan?: string
  }>
  /** Curated social evidence grade for the narrative claim gate (ADR 042) */
  evidenceQuality?: NarrativeEvidenceQuality
}>

/** Schema 23 defaults; the caller passes live config values */
export const DEFAULT_EVIDENCE_QUALITY: NarrativeEvidenceConfig = Object.freeze({
  enabled: true,
  max_promotional_share: 0.5,
  min_independent_authors: 2,
  min_fresh_posts: 2,
  primary_source_handles: [],
})

export type NarrativeEvidenceConfig = Readonly<{
  enabled: boolean
  max_promotional_share: number
  min_independent_authors: number
  min_fresh_posts: number
  primary_source_handles: readonly string[]
}>

type SnapshotItem = SnapshotEnvelope["items"][number]

type SealedSocialSource = Readonly<{
  runId: string
  job: string
  fetchedAt: string
  ageSec: number
  items: SnapshotItem[]
}>

const HISTORICAL_PREFIX = "purpose=historical-source-evaluation"

type SocialSource = Readonly<{
  snapshotName: string
  statusKey: "listScan" | "farcasterScan" | "fomoNarrativeScan"
  source: string
  runId: string
  sealed: SealedSocialSource
}>

/** One receipt line per quality field, so the agent reads the same grade we gate on */
function evidenceQualityItems(
  runId: string,
  fetchedAt: string,
  quality: NarrativeEvidenceQuality,
): SnapshotItem[] {
  const lines = [
    `tier=${quality.tier} enabled=${quality.enabled}`,
    `freshPosts=${quality.freshPosts} independentAuthors=${quality.independentAuthors}`
      + ` promotionalShare=${quality.promotionalShare}`,
    `minFreshPosts=${quality.thresholds.minFreshPosts}`
      + ` minIndependentAuthors=${quality.thresholds.minIndependentAuthors}`
      + ` maxPromotionalShare=${quality.thresholds.maxPromotionalShare}`,
    ...(quality.reasons.length > 0 ? [`reasons=${quality.reasons.join(",")}`] : []),
    ...(quality.primarySourceAuthors.length > 0
      ? [`primarySourceAuthors=${quality.primarySourceAuthors.join(",")}`]
      : []),
    ...Object.entries(quality.excludedCounts)
      .filter(([, count]) => count > 0)
      .map(([reason, count]) => `excluded=${reason} count=${count}`),
  ]
  return lines.map((text, i) => ({
    provenance: `${runId}:narrative-evidence-quality:${i}`,
    text,
    ts: fetchedAt,
    ageSec: 0,
    freshnessTier: "live" as const,
  }))
}

function freshnessForAge(ageSec: number): "live" | "stale" | "expired" {
  if (ageSec <= LIVE_SEC) return "live"
  if (ageSec <= STALE_VISIBLE_SEC) return "stale"
  return "expired"
}

/**
 * Newest complete sealed run that still has usable non-expired evidence.
 * Skips collector-empty/stale newest runs so they cannot mask an older usable snapshot.
 */
async function findNewestUsableSealedRun(
  layout: ArchiveLayout,
  job: "list-scan" | "farcaster-scan" | "fomo-narrative-source-scan",
  nowMs: number,
  opts?: Readonly<{ excludeHistorical?: boolean }>,
): Promise<Readonly<{ runId: string; createdAt: string; sealed: SealedSocialSource }> | undefined> {
  if (!existsSync(layout.transactions)) return undefined
  const candidates: Array<{ runId: string; createdAt: string }> = []
  for (const name of readdirSync(layout.transactions)) {
    if (!name.endsWith(".json")) continue
    const runId = name.slice(0, -".json".length)
    const loaded = await loadJournalForScan(layout, runId)
    if (!loaded || loaded.status !== "complete") continue
    const manifestPath = join(runArchiveDir(layout, runId), "manifest.json")
    if (!existsSync(manifestPath)) continue
    let manifest
    try {
      manifest = RunManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")))
    } catch {
      continue
    }
    if (manifest.job !== job) continue
    candidates.push({ runId, createdAt: manifest.createdAt })
  }
  candidates.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  for (const candidate of candidates.slice(0, MAX_CANDIDATE_RUNS)) {
    const sealed = loadSealedInboxItems(layout, candidate.runId, nowMs, opts)
    if (sealed) return { ...candidate, sealed }
  }
  return undefined
}

function loadSealedInboxItems(
  layout: ArchiveLayout,
  runId: string,
  nowMs: number,
  opts?: Readonly<{ excludeHistorical?: boolean }>,
): SealedSocialSource | undefined {
  const inboxDir = join(runArchiveDir(layout, runId), "inbox")
  if (!existsSync(inboxDir)) return undefined
  const items: SnapshotItem[] = []
  let fetchedAt = ""
  for (const name of readdirSync(inboxDir).sort()) {
    if (!name.endsWith(".json")) continue
    let envelope: SnapshotEnvelope
    try {
      envelope = JSON.parse(readFileSync(join(inboxDir, name), "utf8")) as SnapshotEnvelope
    } catch {
      continue
    }
    if (envelope.trust !== "untrusted-external" || !Array.isArray(envelope.items)) continue
    if (!fetchedAt || Date.parse(envelope.fetchedAt) > Date.parse(fetchedAt)) {
      fetchedAt = envelope.fetchedAt
    }
    for (const item of envelope.items) {
      if (typeof item?.provenance !== "string" || typeof item?.text !== "string") continue
      if (opts?.excludeHistorical && item.text.startsWith(HISTORICAL_PREFIX)) continue
      const itemTs = typeof item.ts === "string" ? item.ts : fetchedAt
      const ageSec = Math.max(0, Math.floor((nowMs - Date.parse(itemTs)) / 1_000))
      const tier = freshnessForAge(ageSec)
      if (tier === "expired") continue
      items.push({
        provenance: item.provenance.slice(0, 256),
        text: item.text.slice(0, 20_000),
        ...(typeof item.url === "string" ? { url: item.url } : {}),
        ts: itemTs,
        ageSec,
        freshnessTier: tier,
        ...(typeof item.dedupeKey === "string" ? { dedupeKey: item.dedupeKey } : {}),
      })
      if (items.length >= MAX_ITEMS) break
    }
    if (items.length >= MAX_ITEMS) break
  }
  if (!fetchedAt || items.length === 0) return undefined
  const ageSec = Math.max(0, Math.floor((nowMs - Date.parse(fetchedAt)) / 1_000))
  if (freshnessForAge(ageSec) === "expired") return undefined
  return {
    runId,
    job: "social",
    fetchedAt,
    ageSec,
    items,
  }
}

export async function collectNarrativeScan(args: Readonly<{
  runId: string
  writer: SnapshotWriter
  fetchedAt: string
  archiveRoot: string
  fetcher?: FetchLike
  /** Defaults to false, so a disabled Farcaster lane stays out of the scan */
  farcasterEnabled?: boolean
  /** Defaults to the schema 23 values when the caller has no config */
  evidenceQuality?: NarrativeEvidenceConfig
}>): Promise<NarrativeCollectResult> {
  const layout = await ensureArchive(args.archiveRoot)
  const nowMs = Date.parse(args.fetchedAt)
  const statusLines: string[] = []
  const names: string[] = []
  const selectedRuns: {
    listScan?: string
    farcasterScan?: string
    fomoNarrativeScan?: string
  } = {}
  let usableEvidence = false

  const listRun = await findNewestUsableSealedRun(layout, "list-scan", nowMs)
  const fcRun = args.farcasterEnabled === true
    ? await findNewestUsableSealedRun(layout, "farcaster-scan", nowMs)
    : undefined
  const fomoRun = await findNewestUsableSealedRun(layout, "fomo-narrative-source-scan", nowMs, {
    excludeHistorical: true,
  })

  const socialSources: SocialSource[] = []
  if (listRun) {
    socialSources.push({
      snapshotName: "narrative-social-list",
      statusKey: "listScan",
      source: `archive.list-scan:${listRun.runId}`,
      runId: listRun.runId,
      sealed: listRun.sealed,
    })
  }
  if (fcRun) {
    socialSources.push({
      snapshotName: "narrative-social-farcaster",
      statusKey: "farcasterScan",
      source: `archive.farcaster-scan:${fcRun.runId}`,
      runId: fcRun.runId,
      sealed: fcRun.sealed,
    })
  }
  if (fomoRun) {
    socialSources.push({
      snapshotName: "narrative-social-fomo-x",
      statusKey: "fomoNarrativeScan",
      source: `archive.fomo-narrative-source-scan:${fomoRun.runId}`,
      runId: fomoRun.runId,
      sealed: fomoRun.sealed,
    })
  }

  // Curate across all sources at once, so a cross-posted item counts once
  const evidenceConfig = args.evidenceQuality ?? DEFAULT_EVIDENCE_QUALITY
  const assessment = curateSocialEvidence({
    items: socialSources.flatMap((entry) => entry.sealed.items),
    primarySourceHandles: evidenceConfig.primary_source_handles,
  })
  const eligibleItems = new Set<SnapshotItem>(assessment.eligible)

  if (listRun) selectedRuns.listScan = listRun.runId
  if (fcRun) selectedRuns.farcasterScan = fcRun.runId
  if (fomoRun) selectedRuns.fomoNarrativeScan = fomoRun.runId

  for (const entry of socialSources) {
    const items = entry.sealed.items.filter((item) => eligibleItems.has(item))
    if (items.length > 0) usableEvidence = true
    await args.writer.writeInbox(args.runId, entry.snapshotName, {
      source: entry.source,
      fetchedAt: args.fetchedAt,
      trust: "untrusted-external",
      items,
    })
    names.push(entry.snapshotName)
    statusLines.push(
      `${entry.statusKey}=${entry.runId} ageSec=${entry.sealed.ageSec}`
        + ` tier=${freshnessForAge(entry.sealed.ageSec)}`
        + ` items=${items.length} rawItems=${entry.sealed.items.length}`,
    )
  }
  if (!listRun) statusLines.push("listScan=none")
  if (args.farcasterEnabled !== true) statusLines.push("farcasterScan=disabled")
  else if (!fcRun) statusLines.push("farcasterScan=none")
  if (!fomoRun) statusLines.push("fomoNarrativeScan=none")

  const evidenceQuality = assessNarrativeEvidenceQuality({
    assessment,
    enabled: evidenceConfig.enabled,
    thresholds: {
      maxPromotionalShare: evidenceConfig.max_promotional_share,
      minIndependentAuthors: evidenceConfig.min_independent_authors,
      minFreshPosts: evidenceConfig.min_fresh_posts,
    },
  })
  await args.writer.writeInbox(args.runId, "narrative-evidence-quality", {
    source: "host.collector",
    fetchedAt: args.fetchedAt,
    trust: "untrusted-external",
    items: evidenceQualityItems(args.runId, args.fetchedAt, evidenceQuality),
  })
  names.push("narrative-evidence-quality")
  statusLines.push(
    `evidenceTier=${evidenceQuality.tier}`
      + ` freshPosts=${evidenceQuality.freshPosts}`
      + ` authors=${evidenceQuality.independentAuthors}`
      + ` promotionalShare=${evidenceQuality.promotionalShare}`,
  )
  for (const reason of evidenceQuality.reasons) {
    statusLines.push(`evidenceReason=${reason}`)
  }
  for (const [reason, count] of Object.entries(assessment.excludedCounts)) {
    if (count > 0) statusLines.push(`evidenceExcluded=${reason} count=${count}`)
  }

  // Demo key only — do not pull full loadEnvSecrets (router/Telegram) just for trending
  const coingeckoDemoKey = process.env["COINGECKO_DEMO_KEY"]?.trim()
  const fetcher = args.fetcher ?? fetch
  const attention = await fetchMarketAttentionForNarrative(
    fetcher,
    coingeckoDemoKey ? { demoKey: coingeckoDemoKey } : {},
  )
  const fallbackItems = attention.fallbackItems ?? []
  const hasMarketEvidence = attention.coins.length > 0
    || attention.categories.length > 0
    || fallbackItems.length > 0
  if (hasMarketEvidence) usableEvidence = true

  // Always seal a narrative-trending snapshot, even when market-blind or empty, so the
  // agent sees an explicit "no category evidence" signal rather than a silent gap.
  const trendingItems: SnapshotItem[] = []
  if (attention.marketBlind) {
    trendingItems.push({
      provenance: `${args.runId}:market-blind`,
      text: `marketBlind=true reason=${attention.marketBlindReason ?? "unknown"}`
        + " rotationConfirmation=missing",
      ts: args.fetchedAt,
      ageSec: 0,
      freshnessTier: "live",
    })
  }
  for (const [i, coin] of attention.coins.slice(0, 50).entries()) {
    trendingItems.push({
      provenance: `${args.runId}:cg-coin:${coin.id}`,
      text: `kind=coin id=${coin.id} name=${coin.name} symbol=${coin.symbol}`
        + (coin.rank !== undefined ? ` rank=${coin.rank}` : ""),
      ts: args.fetchedAt,
      ageSec: 0,
      freshnessTier: "live",
      dedupeKey: `cg-coin:${coin.id}`,
      clusterId: `cg-${i}`,
    })
  }
  for (const [i, cat] of attention.categories.slice(0, 50).entries()) {
    trendingItems.push({
      provenance: `${args.runId}:cg-cat:${cat.id}`,
      text: `kind=category id=${cat.id} name=${cat.name}`
        + (cat.marketCapChange24h !== undefined ? ` marketCapChange24h=${cat.marketCapChange24h}` : ""),
      ts: args.fetchedAt,
      ageSec: 0,
      freshnessTier: "live",
      dedupeKey: `cg-cat:${cat.id}`,
      clusterId: `cg-cat-${i}`,
    })
  }
  for (const [i, item] of fallbackItems.slice(0, 50).entries()) {
    trendingItems.push({
      provenance: `${args.runId}:fallback:${item.kind}:${item.id}`,
      text: `kind=${item.kind} id=${item.id} name=${item.name}`
        + (item.symbol ? ` symbol=${item.symbol}` : "")
        + (item.chainId ? ` chainId=${item.chainId}` : ""),
      ts: args.fetchedAt,
      ageSec: 0,
      freshnessTier: "live",
      dedupeKey: `fallback:${item.kind}:${item.id}`,
      clusterId: `fallback-${i}`,
    })
  }
  await args.writer.writeInbox(args.runId, "narrative-trending", {
    source: attention.source,
    fetchedAt: args.fetchedAt,
    trust: "untrusted-external",
    items: trendingItems,
  })
  names.push("narrative-trending")

  statusLines.push(`marketBlind=${attention.marketBlind}`)
  statusLines.push(`marketSource=${attention.source}`)
  statusLines.push(...attention.statusLines)

  if (!usableEvidence) {
    statusLines.push("usableEvidence=false reason=no-usable-narrative-evidence")
  }

  await args.writer.writeInbox(args.runId, "narrative-collection-status", {
    source: "host.collector",
    fetchedAt: args.fetchedAt,
    trust: "untrusted-external",
    items: statusLines.map((text, i) => ({
      provenance: `${args.runId}:narrative-status:${i}`,
      text,
      ts: args.fetchedAt,
      ageSec: 0,
      freshnessTier: "live" as const,
    })),
  })
  names.push("narrative-collection-status")

  const collectionStatus = !usableEvidence
    ? "skipped"
    : attention.marketBlind
      ? "degraded"
      : "completed"

  return {
    snapshotNames: names,
    postCount: names.length,
    skipAgent: !usableEvidence,
    collectionStatus,
    usableEvidence,
    marketBlind: attention.marketBlind,
    ...(attention.marketBlindReason ? { marketBlindReason: attention.marketBlindReason } : {}),
    selectedRuns,
    evidenceQuality,
  }
}
