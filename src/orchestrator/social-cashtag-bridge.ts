/**
 * Host bridge: multi-author cashtag clusters across list-scan / farcaster-scan
 * runs. Accumulates independent authors, then resolves and enqueues research.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import {
  ResearchQueueEntrySchema,
  SnapshotEnvelopeSchema,
  SocialCashtagBridgeReceiptSchema,
  SocialCashtagClusterFileSchema,
  type CanonicalIdentity,
  type ResearchQueueEntry,
  type SocialCashtagBridgeReceipt,
  type SocialCashtagCluster,
  type SocialCashtagClusterFile,
} from "../contracts/schemas.js"
import { runArchiveDir, writeJsonRecordFsync, type ArchiveLayout } from "../lib/archive.js"
import { getChain } from "../lib/chains.js"
import { loadConfig } from "../lib/config.js"
import { writeAtomicFile } from "../lib/fs-atomic.js"
import {
  GENERIC_CHAIN_SYMBOL_REASON,
  isGenericChainSymbol,
} from "../lib/narrative-tickers.js"
import { enqueueResearch, dedupeKeyFor } from "../lib/research-queue.js"
import { StateStore } from "../lib/state.js"
import type { FetchLike } from "../collectors/market/geckoterminal.js"
import { resolveResearchSubject } from "./research-collect.js"
import { independentSocialAuthorKey } from "./social-author.js"
import { looksPromotional } from "./social-evidence.js"
import {
  disambiguateShortlist,
  extractCashtags,
  extractChainHint,
  type DisambiguationSessionRunner,
} from "./token-disambiguation.js"

export type SocialCashtagObservation = Readonly<{
  symbol: string
  chainHint?: CanonicalIdentity["chain"]
  authorKey: string
  evidenceRef: string
  ts: string
  text: string
}>

const HOST_ONLY_INBOX_RE = /^(?:security|market|meta|collection-status|list-scan-collection-status|farcaster-collection-status|farcaster-collection-receipt|list-scan-alpha-manifest|telegram-alpha-manifest|research-candidates)/iu

function isHostOnlyInboxFile(name: string): boolean {
  if (name.startsWith("telegram-alpha-")) return true
  if (HOST_ONLY_INBOX_RE.test(name)) return true
  return false
}

function clusterKeyFor(
  symbol: string,
  chainHint?: CanonicalIdentity["chain"],
): string {
  const base = symbol.toUpperCase()
  return chainHint ? `${base}:${chainHint}` : base
}

function expiryIso(nowIso: string, days: number): string {
  return new Date(Date.parse(nowIso) + days * 86_400_000).toISOString()
}

function utcDay(nowIso: string): string {
  return nowIso.slice(0, 10)
}

function resolveUnder(root: string, rel: string): string | undefined {
  const base = resolve(root)
  const full = resolve(base, rel)
  if (full !== base && !full.startsWith(base + sep)) return undefined
  return full
}

function emptyReceipt(runId: string, nowIso: string): SocialCashtagBridgeReceipt {
  return SocialCashtagBridgeReceiptSchema.parse({
    schema: 1,
    runId,
    bridgedAt: nowIso,
    scannedItems: 0,
    mergedClusters: 0,
    accepted: [],
    rejected: [],
    parked: [],
  })
}

/**
 * Read sealed social inbox items and extract cashtag observations.
 */
export function scanArchivedSocialCashtags(args: Readonly<{
  layout: ArchiveLayout
  runId: string
  skipPromotional: boolean
}>): readonly SocialCashtagObservation[] {
  const inboxDir = join(runArchiveDir(args.layout, args.runId), "inbox")
  if (!existsSync(inboxDir)) return []

  const out: SocialCashtagObservation[] = []
  for (const fileName of readdirSync(inboxDir).sort()) {
    if (!fileName.endsWith(".json")) continue
    if (fileName.includes("..") || fileName.includes("\0") || fileName.includes("/")) continue
    if (isHostOnlyInboxFile(fileName)) continue

    let envelope
    try {
      envelope = SnapshotEnvelopeSchema.safeParse(
        JSON.parse(readFileSync(join(inboxDir, fileName), "utf8")),
      )
    } catch {
      continue
    }
    if (!envelope.success) continue

    const evidenceRef = `inbox/${args.runId}/${fileName}`
    for (const item of envelope.data.items) {
      if (item.freshnessTier === "expired") continue
      if (args.skipPromotional && looksPromotional(item.text)) continue
      const authorKey = independentSocialAuthorKey(item)
      const chainHint = extractChainHint(item.text)
      for (const symbol of extractCashtags(item.text)) {
        out.push({
          symbol,
          ...(chainHint ? { chainHint } : {}),
          authorKey,
          evidenceRef,
          ts: item.ts,
          text: item.text,
        })
      }
    }
  }
  return out
}

/**
 * Drop clusters whose lastSeen falls outside the rolling window.
 */
export function pruneSocialCashtagClusters(
  file: SocialCashtagClusterFile,
  nowIso: string,
  windowDays: number,
): SocialCashtagClusterFile {
  const cutoff = Date.parse(nowIso) - windowDays * 86_400_000
  const clusters = file.clusters
    .map((cluster) => {
      if (Date.parse(cluster.lastSeen) < cutoff) {
        return { ...cluster, status: "expired" as const }
      }
      return cluster
    })
    .filter((cluster) => cluster.status !== "expired")
  return SocialCashtagClusterFileSchema.parse({ ...file, clusters })
}

/**
 * Upsert cashtag observations into the persistent cluster store.
 */
export function mergeSocialCashtagClusters(args: Readonly<{
  store: SocialCashtagClusterFile
  nowIso: string
  windowDays: number
  maxClusters: number
  minAuthors: number
  observations: readonly SocialCashtagObservation[]
}>): {
  store: SocialCashtagClusterFile
  rejected: SocialCashtagBridgeReceipt["rejected"]
  mergedClusters: number
} {
  const rejected: SocialCashtagBridgeReceipt["rejected"] = []
  let store = pruneSocialCashtagClusters(args.store, args.nowIso, args.windowDays)
  const byKey = new Map(store.clusters.map((c) => [c.clusterKey, { ...c }]))
  let mergedClusters = 0

  for (const obs of args.observations) {
    if (isGenericChainSymbol(obs.symbol)) {
      rejected.push({
        clusterKey: clusterKeyFor(obs.symbol, obs.chainHint),
        reason: GENERIC_CHAIN_SYMBOL_REASON,
      })
      continue
    }

    const key = clusterKeyFor(obs.symbol, obs.chainHint)
    let cluster = byKey.get(key)
    if (!cluster) {
      // Conflicting explicit hint against an unhinted sibling of the same symbol
      if (obs.chainHint) {
        const bare = byKey.get(clusterKeyFor(obs.symbol))
        if (
          bare
          && bare.chainHint
          && bare.chainHint !== obs.chainHint
          && (bare.status === "accumulating" || bare.status === "ready")
        ) {
          rejected.push({ clusterKey: key, reason: "conflicting-chain-hint" })
          continue
        }
      }
      cluster = {
        clusterKey: key,
        symbol: obs.symbol.toUpperCase(),
        ...(obs.chainHint ? { chainHint: obs.chainHint } : {}),
        authors: [],
        evidenceRefs: [],
        firstSeen: obs.ts,
        lastSeen: obs.ts,
        status: "accumulating",
      }
      byKey.set(key, cluster)
      mergedClusters += 1
    } else if (cluster.status === "enqueued" || cluster.status === "rejected") {
      continue
    } else if (
      cluster.chainHint
      && obs.chainHint
      && cluster.chainHint !== obs.chainHint
    ) {
      rejected.push({ clusterKey: key, reason: "conflicting-chain-hint" })
      continue
    }

    if (!cluster.chainHint && obs.chainHint) {
      cluster = { ...cluster, chainHint: obs.chainHint }
    }
    if (!cluster.authors.includes(obs.authorKey)) {
      cluster = {
        ...cluster,
        authors: [...cluster.authors, obs.authorKey].slice(0, 64),
      }
    }
    if (!cluster.evidenceRefs.includes(obs.evidenceRef)) {
      cluster = {
        ...cluster,
        evidenceRefs: [...cluster.evidenceRefs, obs.evidenceRef].slice(0, 32),
      }
    }
    const lastSeen = Date.parse(obs.ts) > Date.parse(cluster.lastSeen)
      ? obs.ts
      : cluster.lastSeen
    const firstSeen = Date.parse(obs.ts) < Date.parse(cluster.firstSeen)
      ? obs.ts
      : cluster.firstSeen
    const status = cluster.authors.length >= args.minAuthors
      ? "ready" as const
      : "accumulating" as const
    cluster = { ...cluster, lastSeen, firstSeen, status }
    byKey.set(key, cluster)
    mergedClusters += 1
  }

  let clusters = [...byKey.values()]
    .sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen))
    .slice(0, args.maxClusters)

  store = SocialCashtagClusterFileSchema.parse({
    ...store,
    clusters,
  })
  return { store, rejected, mergedClusters }
}

async function writeReceiptArtifacts(args: Readonly<{
  agentRoot: string
  layout: ArchiveLayout
  runId: string
  receipt: SocialCashtagBridgeReceipt
}>): Promise<void> {
  const archivePath = join(
    runArchiveDir(args.layout, args.runId),
    "social-cashtag-bridge-receipt.json",
  )
  await writeJsonRecordFsync(archivePath, args.receipt as never)
  const reportDir = resolveUnder(args.agentRoot, join("reports", args.runId))
  if (reportDir) {
    mkdirSync(reportDir, { recursive: true, mode: 0o700 })
    await writeAtomicFile(
      join(reportDir, "social-cashtag-bridge-host.json"),
      `${JSON.stringify(args.receipt, null, 2)}\n`,
    )
  }
}

/**
 * Scan, merge, resolve, and enqueue ready multi-author cashtag clusters.
 */
export async function bridgeReadySocialCashtags(args: Readonly<{
  agentRoot: string
  layout: ArchiveLayout
  runId: string
  nowIso: string
  fetcher?: FetchLike
  runDisambiguation?: DisambiguationSessionRunner
  dryRun?: boolean
}>): Promise<{
  accepted: SocialCashtagBridgeReceipt["accepted"]
  rejected: SocialCashtagBridgeReceipt["rejected"]
  parked: SocialCashtagBridgeReceipt["parked"]
  receipt: SocialCashtagBridgeReceipt
}> {
  const config = loadConfig()
  const bridgeCfg = config.research.social_cashtag_bridge
  if (!bridgeCfg.enabled) {
    const receipt = emptyReceipt(args.runId, args.nowIso)
    await writeReceiptArtifacts({
      agentRoot: args.agentRoot,
      layout: args.layout,
      runId: args.runId,
      receipt,
    })
    return {
      accepted: receipt.accepted,
      rejected: receipt.rejected,
      parked: receipt.parked,
      receipt,
    }
  }

  const fetcher = args.fetcher ?? globalThis.fetch
  const state = new StateStore(join(args.agentRoot, "state"))
  const observations = scanArchivedSocialCashtags({
    layout: args.layout,
    runId: args.runId,
    skipPromotional: bridgeCfg.skip_promotional,
  })

  const merged = mergeSocialCashtagClusters({
    store: state.loadSocialCashtagClusters(),
    nowIso: args.nowIso,
    windowDays: bridgeCfg.window_days,
    maxClusters: bridgeCfg.max_clusters,
    minAuthors: bridgeCfg.min_authors,
    observations,
  })

  let clusterStore = merged.store
  const accepted: SocialCashtagBridgeReceipt["accepted"] = []
  const rejected: SocialCashtagBridgeReceipt["rejected"] = [...merged.rejected]
  const parked: SocialCashtagBridgeReceipt["parked"] = []

  let queue = state.loadResearchQueue()
  const watchlistKeys = new Set(
    state.loadWatchlist().entries.map((entry) => (
      `${entry.identity.chain}:${entry.identity.tokenAddress}`.toLowerCase()
    )),
  )
  const queueKeys = new Set(
    queue.entries
      .filter((entry) => entry.chain && entry.tokenAddress)
      .map((entry) => dedupeKeyFor({
        subject: entry.subject,
        chain: entry.chain,
        tokenAddress: entry.tokenAddress,
      })),
  )

  const today = utcDay(args.nowIso)
  let disambiguationDayCount = (
    clusterStore.disambiguationsToday?.day === today
      ? clusterStore.disambiguationsToday.count
      : 0
  )
  const disambiguationCap = config.research.disambiguation_daily_cap

  const ready = clusterStore.clusters
    .filter((c) => c.status === "ready")
    .sort((a, b) => {
      if (b.authors.length !== a.authors.length) return b.authors.length - a.authors.length
      return a.clusterKey.localeCompare(b.clusterKey)
    })

  const byKey = new Map(clusterStore.clusters.map((c) => [c.clusterKey, { ...c }]))

  const markCluster = (cluster: SocialCashtagCluster): void => {
    byKey.set(cluster.clusterKey, cluster)
  }

  for (const cluster of ready) {
    if (accepted.length >= bridgeCfg.max_enqueues_per_run) {
      rejected.push({ clusterKey: cluster.clusterKey, reason: "over-cap" })
      continue
    }

    const shillText = observations
      .filter((o) => clusterKeyFor(o.symbol, o.chainHint) === cluster.clusterKey)
      .map((o) => o.text)
      .join("\n")
      .slice(0, 4_000)
      || `$${cluster.symbol}`

    let resolved
    try {
      resolved = await resolveResearchSubject(
        {
          subject: cluster.symbol,
          ...(cluster.chainHint ? { chainHint: cluster.chainHint } : {}),
          tokenHint: cluster.symbol,
        },
        fetcher as typeof fetch,
      )
    } catch {
      resolved = { status: "empty" as const }
    }

    const tryEnqueue = async (
      identity: CanonicalIdentity,
      path: "ticker-resolved" | "ticker-model",
    ): Promise<boolean> => {
      if (!getChain(identity.chain)?.securityScanner) {
        rejected.push({ clusterKey: cluster.clusterKey, reason: "unsupported-chain" })
        markCluster({
          ...cluster,
          status: "rejected",
          rejectReason: "unsupported-chain",
        })
        return false
      }
      const key = `${identity.chain}:${identity.tokenAddress}`.toLowerCase()
      if (watchlistKeys.has(key)) {
        rejected.push({ clusterKey: cluster.clusterKey, reason: "duplicated-watchlist" })
        markCluster({
          ...cluster,
          status: "rejected",
          rejectReason: "duplicated-watchlist",
        })
        return false
      }
      if (queueKeys.has(key)) {
        rejected.push({ clusterKey: cluster.clusterKey, reason: "duplicated-queue" })
        markCluster({
          ...cluster,
          status: "rejected",
          rejectReason: "duplicated-queue",
        })
        return false
      }
      const queueId = `rq-cashtag-${args.runId}-${accepted.length + 1}`.slice(0, 128)
      const entry: ResearchQueueEntry = ResearchQueueEntrySchema.parse({
        schema: 1,
        queueId,
        subject: `${identity.chain}:${identity.tokenAddress}`,
        chain: identity.chain,
        tokenAddress: identity.tokenAddress,
        ...(identity.pairAddress ? { pairAddress: identity.pairAddress } : {}),
        ...(identity.symbolDisplay ? { symbolDisplay: identity.symbolDisplay } : {}),
        resolution: path === "ticker-model" ? "model-confirmed" : "resolved",
        priority: 50,
        firstSeen: cluster.firstSeen,
        enqueuedAt: args.nowIso,
        enqueuedBy: `social-cashtag-bridge:${args.runId}`.slice(0, 128),
        trigger: "social",
        expiresAt: expiryIso(args.nowIso, config.research.queue_expiry_days),
        provenance: [
          `social-cashtag-bridge:${cluster.clusterKey}`,
          ...cluster.evidenceRefs,
        ].slice(0, 32),
        clusterCount: Math.max(2, cluster.authors.length),
        security: { status: "pending", flags: [] },
        status: "pending",
        reason: `social cashtag $${cluster.symbol} (${cluster.authors.length} authors)`.slice(0, 280),
      })
      if (!args.dryRun) {
        queue = enqueueResearch(queue, entry, config.research.daily_cap)
      }
      queueKeys.add(key)
      accepted.push({
        clusterKey: cluster.clusterKey,
        queueId,
        chain: identity.chain,
        tokenAddress: identity.tokenAddress,
        authorCount: cluster.authors.length,
        path,
      })
      markCluster({
        ...cluster,
        status: "enqueued",
        queueId,
        resolved: {
          chain: identity.chain,
          tokenAddress: identity.tokenAddress,
          ...(identity.pairAddress ? { pairAddress: identity.pairAddress } : {}),
          ...(identity.symbolDisplay ? { symbolDisplay: identity.symbolDisplay } : {}),
          resolution: path === "ticker-model" ? "model-confirmed" : "resolved",
        },
      })
      return true
    }

    if (resolved.status === "resolved") {
      await tryEnqueue(resolved.identity, "ticker-resolved")
      continue
    }

    if (resolved.status === "ambiguous" && resolved.shortlist.length > 0) {
      const picked = await disambiguateShortlist({
        shortlist: resolved.shortlist,
        shillText,
        ticker: cluster.symbol,
        ...(cluster.chainHint ? { chainHint: cluster.chainHint } : {}),
        fetcher,
        ...(args.runDisambiguation
          ? { runDisambiguation: args.runDisambiguation }
          : {}),
        disambiguationDayCount,
        disambiguationCap,
      })
      if (picked.spentDisambiguation) {
        disambiguationDayCount += 1
      }
      if (picked.ok) {
        await tryEnqueue(
          {
            ...picked.identity,
            resolution: "model-confirmed",
            resolutionConfidence: picked.confidence,
          },
          "ticker-model",
        )
      } else {
        parked.push({
          clusterKey: cluster.clusterKey,
          subject: cluster.symbol,
        })
        if (!args.dryRun && picked.reason !== "disambiguation:daily-cap") {
          const queueId = `rq-cashtag-amb-${args.runId}-${parked.length}`.slice(0, 128)
          const amb: ResearchQueueEntry = ResearchQueueEntrySchema.parse({
            schema: 1,
            queueId,
            subject: cluster.symbol.slice(0, 256),
            resolution: "ambiguous",
            priority: 50,
            firstSeen: cluster.firstSeen,
            enqueuedAt: args.nowIso,
            enqueuedBy: `social-cashtag-bridge:${args.runId}`.slice(0, 128),
            trigger: "social",
            expiresAt: expiryIso(args.nowIso, config.research.queue_expiry_days),
            provenance: [
              `social-cashtag-bridge:${cluster.clusterKey}`,
              ...cluster.evidenceRefs,
              ...resolved.shortlist.slice(0, 8).map((s) => `${s.chain}:${s.tokenAddress}`),
            ].slice(0, 32),
            clusterCount: Math.max(2, cluster.authors.length),
            security: { status: "pending", flags: [] },
            status: "ambiguous",
            reason: picked.reason.slice(0, 280),
          })
          queue = enqueueResearch(queue, amb, 10_000)
        }
        // Keep ready so later evidence or a new day can retry
      }
      continue
    }

    rejected.push({
      clusterKey: cluster.clusterKey,
      reason: resolved.status === "unsupported-chain"
        ? "unsupported-chain"
        : "ticker-unresolved",
    })
    markCluster({
      ...cluster,
      status: "rejected",
      rejectReason: resolved.status === "unsupported-chain"
        ? "unsupported-chain"
        : "ticker-unresolved",
    })
  }

  clusterStore = SocialCashtagClusterFileSchema.parse({
    schema: 1,
    clusters: [...byKey.values()],
    disambiguationsToday: { day: today, count: disambiguationDayCount },
  })

  if (!args.dryRun) {
    await state.saveSocialCashtagClusters(clusterStore)
    if (accepted.length > 0 || parked.length > 0) {
      await state.saveResearchQueue(queue)
    }
  }

  const receipt = SocialCashtagBridgeReceiptSchema.parse({
    schema: 1,
    runId: args.runId,
    bridgedAt: args.nowIso,
    scannedItems: observations.length,
    mergedClusters: merged.mergedClusters,
    accepted,
    rejected: rejected.slice(0, 200),
    parked: parked.slice(0, 32),
  })
  await writeReceiptArtifacts({
    agentRoot: args.agentRoot,
    layout: args.layout,
    runId: args.runId,
    receipt,
  })
  return { accepted, rejected: receipt.rejected, parked: receipt.parked, receipt }
}
