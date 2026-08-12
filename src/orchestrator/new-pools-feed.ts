import { join } from "node:path"
import type { SnapshotWriter } from "../lib/snapshot.js"
import { loadConfig, securityThresholdsFromConfig } from "../lib/config.js"
import { getChain } from "../lib/chains.js"
import { StateStore } from "../lib/state.js"
import { archiveLayout } from "../lib/archive.js"
import { sha256Json } from "../lib/canonical-json.js"
import { isNativeOrWrapMint } from "../lib/native-mints.js"
import {
  fetchGeckoNewPools,
  type FetchLike,
  type GeckoPool,
} from "../collectors/market/geckoterminal.js"
import {
  fetchDexScreenerPair,
  type MarketPair,
} from "../collectors/market/providers.js"
import {
  fetchSecurityGate,
  preflightMarketQuality,
} from "../collectors/market/security.js"
import {
  type MarketQualityReason,
  type NewPoolsFeedItem,
} from "../contracts/schemas.js"
import { appendDiscoveryLog } from "./discovery-log.js"

export type NewPoolRejectReason =
  | "unsupported-chain"
  | "missing-identity"
  | "native-or-wrap"
  | "pool-too-young"
  | "pool-too-old"
  | "duplicate-watchlist"
  | "duplicate-queue"
  | "duplicate-run"
  | "security-hard-fail"
  | "security-pending"
  | "security-unsupported"
  | "pair-resolve-failed"
  | "cap-exceeded"

export type NewPoolResolvedCandidate = Readonly<{
  chain: string
  tokenAddress: string
  pairAddress: string
  symbolDisplay?: string
  poolCreatedAt?: string
  poolAgeMinutes?: number
  liquidityUsd?: number
  pair: MarketPair
  provenance: string
  poolAddress: string
}>

export type NewPoolFilterResult =
  | Readonly<{ status: "accept"; item: NewPoolsFeedItem }>
  | Readonly<{
    status: "reject"
    reason: NewPoolRejectReason
    chain?: string
    tokenAddress?: string
    pairAddress?: string
    subject?: string
    securityStatus?: "pass" | "fail" | "pending"
    marketQualityReasons?: readonly MarketQualityReason[]
    provenance?: string
  }>

export type NewPoolsFeedResult = Readonly<{
  snapshotName?: string
  survivors: readonly NewPoolsFeedItem[]
  rejected: readonly Readonly<{
    reason: NewPoolRejectReason
    chain?: string
    tokenAddress?: string
    pairAddress?: string
  }>[]
  statusLines: readonly string[]
}>

function tokenKey(chain: string, tokenAddress: string): string {
  return `${chain}:${tokenAddress}`.toLowerCase()
}

function poolAgeMinutes(
  createdAt: string | undefined,
  nowMs: number,
): number | undefined {
  if (!createdAt) return undefined
  const created = Date.parse(createdAt)
  if (!Number.isFinite(created)) return undefined
  return Math.max(0, (nowMs - created) / 60_000)
}

export function pickNonNativeToken(
  pair: MarketPair,
): Readonly<{ address: string; symbol: string; name: string }> | undefined {
  if (!isNativeOrWrapMint(pair.baseToken.address, pair.baseToken.symbol)) {
    return pair.baseToken
  }
  if (!isNativeOrWrapMint(pair.quoteToken.address, pair.quoteToken.symbol)) {
    return pair.quoteToken
  }
  return undefined
}

export async function resolveGeckoPoolCandidate(args: Readonly<{
  chain: string
  pool: GeckoPool
  fetcher: FetchLike
  fetchedAt: string
}>): Promise<
  | Readonly<{ status: "ok"; candidate: NewPoolResolvedCandidate }>
  | Readonly<{ status: "reject"; reason: NewPoolRejectReason }>
> {
  const chainMeta = getChain(args.chain)
  if (!chainMeta?.geckoterminalNetwork || !chainMeta.dexscreenerChainId) {
    return { status: "reject", reason: "unsupported-chain" }
  }
  let pairs: MarketPair[]
  try {
    pairs = await fetchDexScreenerPair(
      args.fetcher,
      chainMeta.dexscreenerChainId,
      args.pool.address,
    )
  } catch {
    return { status: "reject", reason: "pair-resolve-failed" }
  }
  const pair = pairs[0]
  if (!pair) return { status: "reject", reason: "missing-identity" }
  const token = pickNonNativeToken(pair)
  if (!token) return { status: "reject", reason: "native-or-wrap" }
  const age = poolAgeMinutes(args.pool.createdAt, Date.parse(args.fetchedAt))
  const provenance = `feed:new-pools:gecko:${args.chain}:${args.pool.address}`
  return {
    status: "ok",
    candidate: {
      chain: args.chain,
      tokenAddress: token.address,
      pairAddress: pair.pairAddress,
      symbolDisplay: token.symbol.slice(0, 32),
      ...(args.pool.createdAt ? { poolCreatedAt: args.pool.createdAt } : {}),
      ...(age !== undefined ? { poolAgeMinutes: age } : {}),
      ...(pair.liquidityUsd !== undefined ? { liquidityUsd: pair.liquidityUsd } : {}),
      pair,
      provenance: provenance.slice(0, 256),
      poolAddress: args.pool.address,
    },
  }
}

export function filterNewPoolCandidate(args: Readonly<{
  candidate: NewPoolResolvedCandidate
  minPoolAgeMinutes: number
  maxPoolAgeHours: number
  seenKeys: ReadonlySet<string>
  watchlistKeys: ReadonlySet<string>
  queueKeys: ReadonlySet<string>
  securityStatus: "pass" | "fail" | "pending"
  securityFlags: readonly string[]
  marketQualityStatus: "pass" | "fail"
  marketQualityReasons: readonly MarketQualityReason[]
}>): NewPoolFilterResult {
  const { candidate } = args
  const key = tokenKey(candidate.chain, candidate.tokenAddress)
  if (args.watchlistKeys.has(key)) {
    return {
      status: "reject",
      reason: "duplicate-watchlist",
      chain: candidate.chain,
      tokenAddress: candidate.tokenAddress,
      pairAddress: candidate.pairAddress,
      provenance: candidate.provenance,
    }
  }
  if (args.queueKeys.has(key)) {
    return {
      status: "reject",
      reason: "duplicate-queue",
      chain: candidate.chain,
      tokenAddress: candidate.tokenAddress,
      pairAddress: candidate.pairAddress,
      provenance: candidate.provenance,
    }
  }
  if (args.seenKeys.has(key)) {
    return {
      status: "reject",
      reason: "duplicate-run",
      chain: candidate.chain,
      tokenAddress: candidate.tokenAddress,
      pairAddress: candidate.pairAddress,
      provenance: candidate.provenance,
    }
  }
  if (candidate.poolAgeMinutes === undefined) {
    return {
      status: "reject",
      reason: "pool-too-young",
      chain: candidate.chain,
      tokenAddress: candidate.tokenAddress,
      pairAddress: candidate.pairAddress,
      provenance: candidate.provenance,
    }
  }
  if (candidate.poolAgeMinutes < args.minPoolAgeMinutes) {
    return {
      status: "reject",
      reason: "pool-too-young",
      chain: candidate.chain,
      tokenAddress: candidate.tokenAddress,
      pairAddress: candidate.pairAddress,
      provenance: candidate.provenance,
    }
  }
  if (candidate.poolAgeMinutes > args.maxPoolAgeHours * 60) {
    return {
      status: "reject",
      reason: "pool-too-old",
      chain: candidate.chain,
      tokenAddress: candidate.tokenAddress,
      pairAddress: candidate.pairAddress,
      provenance: candidate.provenance,
    }
  }
  if (args.securityStatus === "fail") {
    return {
      status: "reject",
      reason: "security-hard-fail",
      chain: candidate.chain,
      tokenAddress: candidate.tokenAddress,
      pairAddress: candidate.pairAddress,
      securityStatus: "fail",
      marketQualityReasons: args.marketQualityReasons,
      provenance: candidate.provenance,
    }
  }
  if (args.securityStatus === "pending") {
    return {
      status: "reject",
      reason: "security-pending",
      chain: candidate.chain,
      tokenAddress: candidate.tokenAddress,
      pairAddress: candidate.pairAddress,
      securityStatus: "pending",
      marketQualityReasons: args.marketQualityReasons,
      provenance: candidate.provenance,
    }
  }
  const item: NewPoolsFeedItem = {
    chain: candidate.chain as NewPoolsFeedItem["chain"],
    tokenAddress: candidate.tokenAddress,
    pairAddress: candidate.pairAddress,
    ...(candidate.symbolDisplay ? { symbolDisplay: candidate.symbolDisplay } : {}),
    ...(candidate.poolCreatedAt ? { poolCreatedAt: candidate.poolCreatedAt } : {}),
    ...(candidate.poolAgeMinutes !== undefined
      ? { poolAgeMinutes: candidate.poolAgeMinutes }
      : {}),
    ...(candidate.liquidityUsd !== undefined
      ? { liquidityUsd: candidate.liquidityUsd }
      : {}),
    securityStatus: "pass",
    securityFlags: [...args.securityFlags].slice(0, 32),
    marketQualityStatus: args.marketQualityStatus,
    marketQualityReasons: [...args.marketQualityReasons].slice(0, 8),
    provenance: candidate.provenance,
  }
  return { status: "accept", item }
}

export function sortNewPoolCandidates(
  items: readonly NewPoolsFeedItem[],
): NewPoolsFeedItem[] {
  return [...items].sort((a, b) => {
    const aPass = a.marketQualityStatus === "pass" ? 1 : 0
    const bPass = b.marketQualityStatus === "pass" ? 1 : 0
    if (aPass !== bPass) return bPass - aPass
    const aLiq = a.liquidityUsd ?? -1
    const bLiq = b.liquidityUsd ?? -1
    if (aLiq !== bLiq) return bLiq - aLiq
    const aAge = a.poolAgeMinutes ?? Number.POSITIVE_INFINITY
    const bAge = b.poolAgeMinutes ?? Number.POSITIVE_INFINITY
    if (aAge !== bAge) return aAge - bAge
    return a.tokenAddress.localeCompare(b.tokenAddress)
  })
}

function mapSecurityStatus(
  status: "pass" | "hard-fail" | "pending" | "unsupported-chain",
): "pass" | "fail" | "pending" | "unsupported" {
  if (status === "hard-fail") return "fail"
  if (status === "unsupported-chain") return "unsupported"
  return status
}

function discoveryRecordId(parts: Readonly<Record<string, string>>): string {
  const digest = sha256Json({
    kind: "discovery-new-pools",
    ...parts,
  } as never).replace(/^sha256:/u, "")
  return `dl-np-${digest.slice(0, 40)}`
}

async function logOutcome(args: Readonly<{
  archiveRoot: string
  runId: string
  fetchedAt: string
  reason: string
  chain?: string
  tokenAddress?: string
  pairAddress?: string
  securityStatus?: "pass" | "fail" | "pending"
  marketQualityReasons?: readonly string[]
  provenance?: string
}>): Promise<void> {
  const layout = archiveLayout(args.archiveRoot)
  await appendDiscoveryLog(layout, {
    schema: 1,
    recordId: discoveryRecordId({
      runId: args.runId,
      reason: args.reason,
      chain: args.chain ?? "",
      token: args.tokenAddress ?? "",
      pair: args.pairAddress ?? "",
      prov: args.provenance ?? "",
    }),
    recordedAt: args.fetchedAt,
    runId: args.runId,
    trigger: "new-pools",
    ...(args.chain ? { chain: args.chain as never } : {}),
    ...(args.tokenAddress ? { tokenAddress: args.tokenAddress } : {}),
    ...(args.pairAddress ? { pairAddress: args.pairAddress } : {}),
    reason: args.reason.slice(0, 120),
    source: "gecko-new-pools",
    ...(args.securityStatus ? { securityStatus: args.securityStatus } : {}),
    ...(args.marketQualityReasons && args.marketQualityReasons.length > 0
      ? { marketQualityReasons: [...args.marketQualityReasons].slice(0, 8) }
      : {}),
    surfacedAt: args.fetchedAt,
  })
}

export async function collectNewPoolsFeed(args: Readonly<{
  runId: string
  writer: SnapshotWriter
  fetchedAt: string
  agentRoot: string
  archiveRoot: string
  fetcher?: FetchLike
}>): Promise<NewPoolsFeedResult> {
  const config = loadConfig()
  const feed = config.new_pools_feed
  if (!feed.enabled) {
    return { survivors: [], rejected: [], statusLines: ["new-pools:disabled"] }
  }

  const fetcher = args.fetcher ?? globalThis.fetch
  const thresholds = securityThresholdsFromConfig(config)
  const state = new StateStore(join(args.agentRoot, "state"))
  let watchlistKeys = new Set<string>()
  let queueKeys = new Set<string>()
  try {
    watchlistKeys = new Set(
      state.loadWatchlist().entries.map((entry) => (
        tokenKey(entry.identity.chain, entry.identity.tokenAddress)
      )),
    )
  } catch {
    watchlistKeys = new Set()
  }
  try {
    queueKeys = new Set(
      state.loadResearchQueue().entries
        .filter((entry) => entry.chain && entry.tokenAddress)
        .map((entry) => tokenKey(entry.chain!, entry.tokenAddress!)),
    )
  } catch {
    queueKeys = new Set()
  }

  const seenKeys = new Set<string>()
  const survivorsRaw: NewPoolsFeedItem[] = []
  const rejected: {
    reason: NewPoolRejectReason
    chain?: string
    tokenAddress?: string
    pairAddress?: string
  }[] = []
  const statusLines: string[] = []
  let poolsSeen = 0

  for (const chain of feed.chains) {
    const chainMeta = getChain(chain)
    if (!chainMeta?.geckoterminalNetwork) {
      rejected.push({ reason: "unsupported-chain", chain })
      await logOutcome({
        archiveRoot: args.archiveRoot,
        runId: args.runId,
        fetchedAt: args.fetchedAt,
        reason: "unsupported-chain",
        chain,
      })
      continue
    }
    let pools: GeckoPool[]
    try {
      pools = await fetchGeckoNewPools(fetcher, {
        network: chainMeta.geckoterminalNetwork,
        page: feed.gecko_page,
      })
    } catch {
      statusLines.push(
        `new-pools:${chain}:fetch-fail`,
      )
      continue
    }
    poolsSeen += pools.length
    for (const pool of pools) {
      const resolved = await resolveGeckoPoolCandidate({
        chain,
        pool,
        fetcher,
        fetchedAt: args.fetchedAt,
      })
      if (resolved.status === "reject") {
        rejected.push({ reason: resolved.reason, chain, pairAddress: pool.address })
        await logOutcome({
          archiveRoot: args.archiveRoot,
          runId: args.runId,
          fetchedAt: args.fetchedAt,
          reason: resolved.reason,
          chain,
          pairAddress: pool.address,
        })
        continue
      }
      const { candidate } = resolved
      const gate = await fetchSecurityGate(
        fetcher,
        candidate.chain,
        candidate.tokenAddress,
        thresholds,
      )
      const mapped = mapSecurityStatus(gate.status)
      if (mapped === "unsupported") {
        rejected.push({
          reason: "security-unsupported",
          chain: candidate.chain,
          tokenAddress: candidate.tokenAddress,
          pairAddress: candidate.pairAddress,
        })
        await logOutcome({
          archiveRoot: args.archiveRoot,
          runId: args.runId,
          fetchedAt: args.fetchedAt,
          reason: "security-unsupported",
          chain: candidate.chain,
          tokenAddress: candidate.tokenAddress,
          pairAddress: candidate.pairAddress,
          securityStatus: "pending",
          provenance: candidate.provenance,
        })
        continue
      }
      const quality = preflightMarketQuality(candidate.pair, undefined, thresholds)
      const decision = filterNewPoolCandidate({
        candidate,
        minPoolAgeMinutes: feed.min_pool_age_minutes,
        maxPoolAgeHours: feed.max_pool_age_hours,
        seenKeys,
        watchlistKeys,
        queueKeys,
        securityStatus: mapped,
        securityFlags: gate.flags,
        marketQualityStatus: quality.status,
        marketQualityReasons: quality.reasons,
      })
      if (decision.status === "reject") {
        rejected.push({
          reason: decision.reason,
          ...(decision.chain ? { chain: decision.chain } : {}),
          ...(decision.tokenAddress ? { tokenAddress: decision.tokenAddress } : {}),
          ...(decision.pairAddress ? { pairAddress: decision.pairAddress } : {}),
        })
        await logOutcome({
          archiveRoot: args.archiveRoot,
          runId: args.runId,
          fetchedAt: args.fetchedAt,
          reason: decision.reason,
          ...(decision.chain ? { chain: decision.chain } : {}),
          ...(decision.tokenAddress ? { tokenAddress: decision.tokenAddress } : {}),
          ...(decision.pairAddress ? { pairAddress: decision.pairAddress } : {}),
          ...(decision.securityStatus
            ? { securityStatus: decision.securityStatus }
            : {}),
          ...(decision.marketQualityReasons
            ? { marketQualityReasons: decision.marketQualityReasons }
            : {}),
          ...(decision.provenance ? { provenance: decision.provenance } : {}),
        })
        continue
      }
      seenKeys.add(tokenKey(decision.item.chain, decision.item.tokenAddress))
      survivorsRaw.push(decision.item)
    }
  }

  const sorted = sortNewPoolCandidates(survivorsRaw)
  const survivors = sorted.slice(0, feed.max_candidates_per_run)
  for (const item of sorted.slice(feed.max_candidates_per_run)) {
    rejected.push({
      reason: "cap-exceeded",
      chain: item.chain,
      tokenAddress: item.tokenAddress,
      pairAddress: item.pairAddress,
    })
    await logOutcome({
      archiveRoot: args.archiveRoot,
      runId: args.runId,
      fetchedAt: args.fetchedAt,
      reason: "cap-exceeded",
      chain: item.chain,
      tokenAddress: item.tokenAddress,
      pairAddress: item.pairAddress,
      securityStatus: item.securityStatus,
      marketQualityReasons: item.marketQualityReasons,
      provenance: item.provenance,
    })
  }

  for (const item of survivors) {
    await logOutcome({
      archiveRoot: args.archiveRoot,
      runId: args.runId,
      fetchedAt: args.fetchedAt,
      reason: "candidate-accepted",
      chain: item.chain,
      tokenAddress: item.tokenAddress,
      pairAddress: item.pairAddress,
      securityStatus: item.securityStatus,
      marketQualityReasons: item.marketQualityReasons,
      provenance: item.provenance,
    })
  }

  let snapshotName: string | undefined
  if (survivors.length > 0) {
    await args.writer.writeInbox(args.runId, "list-scan-new-pools", {
      source: "host.new-pools-feed",
      fetchedAt: args.fetchedAt,
      trust: "untrusted-external",
      items: survivors.map((item) => ({
        provenance: item.provenance,
        text: [
          `chain=${item.chain}`,
          `token=${item.tokenAddress}`,
          `pair=${item.pairAddress}`,
          `security=${item.securityStatus}`,
          `mq=${item.marketQualityStatus}`,
          ...(item.marketQualityReasons.length > 0
            ? [`mqReasons=${item.marketQualityReasons.join(",")}`]
            : []),
          ...(item.liquidityUsd !== undefined
            ? [`liquidityUsd=${item.liquidityUsd}`]
            : []),
          ...(item.poolAgeMinutes !== undefined
            ? [`poolAgeMinutes=${item.poolAgeMinutes}`]
            : []),
        ].join(" "),
        ts: args.fetchedAt,
        ageSec: 0,
        freshnessTier: "live" as const,
        dedupeKey: tokenKey(item.chain, item.tokenAddress),
      })),
    })
    snapshotName = "list-scan-new-pools"
  }

  statusLines.push(
    `new-pools:seen=${poolsSeen}`,
    `new-pools:survivors=${survivors.length}`,
    `new-pools:rejected=${rejected.length}`,
  )

  return {
    ...(snapshotName ? { snapshotName } : {}),
    survivors,
    rejected,
    statusLines,
  }
}
