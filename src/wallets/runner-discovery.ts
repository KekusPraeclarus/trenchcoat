import type { WalletDiscoveryOrigin } from "../contracts/schemas.js"
import type { WalletDiscoverySighting } from "./discovery.js"

export type RunnerBuyerEvent = Readonly<{
  chain: string
  tokenAddress: string
  walletAddress: string
  boughtAtIso: string
  providerEventId: string
  runnerId: string
  blockOrSlot?: number
}>

export type RunnerQualification = Readonly<{
  maxAgeHours: number
  minLiquidityUsd: number
  minReturn6h: number
  minVolume6hUsd: number
}>

export type RunnerPoolCandidate = Readonly<{
  runnerId: string
  chain: string
  poolAddress: string
  tokenAddress: string
  pairAddress: string
  firstSeenAt: string
  liquidityUsd?: number
  return6h?: number
  volume6hUsd?: number
  securityHardFail?: boolean
}>

export type RankedRunnerBuyers = Readonly<{
  runnerId: string
  chain: string
  tokenAddress: string
  buyers: readonly string[]
}>

export function qualifyRunnerPool(
  pool: RunnerPoolCandidate,
  nowIso: string,
  q: RunnerQualification,
): string | undefined {
  if (pool.securityHardFail) return "security-hard-fail"
  if (!pool.tokenAddress || !pool.pairAddress) return "identity-missing"
  const ageMs = Date.parse(nowIso) - Date.parse(pool.firstSeenAt)
  if (!Number.isFinite(ageMs) || ageMs < 0) return "age-unknown"
  if (ageMs > q.maxAgeHours * 3_600_000) return "age-exceeded"
  if (pool.liquidityUsd === undefined || !Number.isFinite(pool.liquidityUsd)) return "liquidity-unknown"
  if (pool.liquidityUsd < q.minLiquidityUsd) return "liquidity-low"
  if (pool.return6h === undefined || !Number.isFinite(pool.return6h)) return "return-unknown"
  if (pool.return6h < q.minReturn6h) return "return-low"
  if (pool.volume6hUsd === undefined || !Number.isFinite(pool.volume6hUsd)) return "volume-unknown"
  if (pool.volume6hUsd < q.minVolume6hUsd) return "volume-low"
  return undefined
}

/** First N earliest verified buyers inside the first windowMinutes after pool firstSeen */
export function rankEarlyRunnerBuyers(
  events: readonly RunnerBuyerEvent[],
  args: Readonly<{
    runnerId: string
    firstSeenAt: string
    windowMinutes: number
    topN: number
  }>,
): RankedRunnerBuyers | undefined {
  const windowEnd = Date.parse(args.firstSeenAt) + args.windowMinutes * 60_000
  const forRunner = events
    .filter((e) => e.runnerId === args.runnerId)
    .filter((e) => {
      const ts = Date.parse(e.boughtAtIso)
      return Number.isFinite(ts) && ts >= Date.parse(args.firstSeenAt) && ts <= windowEnd
    })
    .sort((a, b) => Date.parse(a.boughtAtIso) - Date.parse(b.boughtAtIso)
      || a.providerEventId.localeCompare(b.providerEventId)
      || a.walletAddress.localeCompare(b.walletAddress))

  const seen = new Set<string>()
  const buyers: string[] = []
  for (const event of forRunner) {
    const key = event.walletAddress.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    buyers.push(event.walletAddress)
    if (buyers.length >= args.topN) break
  }
  if (buyers.length === 0) return undefined
  const sample = forRunner[0]!
  return {
    runnerId: args.runnerId,
    chain: sample.chain,
    tokenAddress: sample.tokenAddress,
    buyers,
  }
}

export type SightingHistory = Readonly<{
  walletKey: string
  runnerIds: readonly string[]
  lastSeenIso: string
}>

/** Require appearance on ≥ minRunners distinct runners within lookbackDays */
export function walletsMeetingRecurrence(
  histories: readonly SightingHistory[],
  args: Readonly<{
    minRunners: number
    lookbackDays: number
    nowIso: string
  }>,
): readonly string[] {
  const cutoff = Date.parse(args.nowIso) - args.lookbackDays * 86_400_000
  const out: string[] = []
  for (const h of histories) {
    if (Date.parse(h.lastSeenIso) < cutoff) continue
    const distinct = new Set(h.runnerIds)
    if (distinct.size >= args.minRunners) out.push(h.walletKey)
  }
  return out.sort()
}

export type AntiAutomationEvidence = Readonly<{
  buysLastHour: number
  distinctTokensLastDay: number
  sameSlotBuyRatio?: number
  sameSlotBuySample?: number
  sameFunderClusterSize?: number
}>

export type AntiAutomationThresholds = Readonly<{
  maxBuysPerHour: number
  maxDistinctTokensPerDay: number
  sameSlotRatio: number
  sameSlotMinBuys: number
  sameFunderClusterMax: number
}>

export function antiAutomationRejectReason(
  evidence: AntiAutomationEvidence,
  thresholds: AntiAutomationThresholds,
): string | undefined {
  if (evidence.buysLastHour > thresholds.maxBuysPerHour) return "buys-per-hour"
  if (evidence.distinctTokensLastDay > thresholds.maxDistinctTokensPerDay) {
    return "distinct-tokens-day"
  }
  if (
    evidence.sameSlotBuySample !== undefined
    && evidence.sameSlotBuyRatio !== undefined
    && evidence.sameSlotBuySample >= thresholds.sameSlotMinBuys
    && evidence.sameSlotBuyRatio >= thresholds.sameSlotRatio
  ) {
    return "same-slot-cluster"
  }
  if (
    evidence.sameFunderClusterSize !== undefined
    && evidence.sameFunderClusterSize >= thresholds.sameFunderClusterMax
  ) {
    return "same-funder-cluster"
  }
  return undefined
}

export function toNewPoolsSightings(
  ranked: readonly RankedRunnerBuyers[],
): WalletDiscoverySighting[] {
  const origin: WalletDiscoveryOrigin = "new-pools"
  const out: WalletDiscoverySighting[] = []
  for (const row of ranked) {
    for (const address of row.buyers) {
      out.push({
        chain: row.chain,
        address,
        origin,
        tokenAddress: row.tokenAddress,
      })
    }
  }
  return out
}

export function capNewCandidates(
  sightings: readonly WalletDiscoverySighting[],
  maxPerRun: number,
): WalletDiscoverySighting[] {
  if (sightings.length <= maxPerRun) return [...sightings]
  return [...sightings]
    .sort((a, b) => (
      a.chain.localeCompare(b.chain)
      || a.address.localeCompare(b.address)
      || (a.tokenAddress ?? "").localeCompare(b.tokenAddress ?? "")
    ))
    .slice(0, maxPerRun)
}
