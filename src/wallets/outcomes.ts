import { wilsonLowerBound } from "../orchestrator/audit-math.js"
import type { WalletBuyOutcome, WalletPerformance } from "../contracts/schemas.js"
import type { WalletEvidence } from "./scoring.js"

export function aggregateWalletPerformance(
  walletId: string,
  outcomes: readonly WalletBuyOutcome[],
  scoreCutoff: string,
  nowIso: string,
): WalletPerformance {
  const cutoffMs = Date.parse(scoreCutoff)
  if (!Number.isFinite(cutoffMs)) throw new TypeError("Invalid score cutoff")

  const deduped = new Map<string, WalletBuyOutcome>()
  for (const outcome of outcomes) {
    if (outcome.walletId !== walletId) continue
    if (!outcome.finalized || outcome.removed || !outcome.priceable) continue
    if (Date.parse(outcome.boughtAt) >= cutoffMs) continue
    if (!deduped.has(outcome.eventId)) deduped.set(outcome.eventId, outcome)
  }

  const eligible = [...deduped.values()]
  const settled = eligible.filter((outcome) => (
    outcome.settledAt !== undefined
    && Date.parse(outcome.settledAt) <= cutoffMs
    && outcome.excessReturn72h !== undefined
  ))
  const hits = settled.filter((outcome) => outcome.excessReturn72h! >= 0.20)
  const excess = settled
    .map((outcome) => outcome.excessReturn72h!)
    .sort((left, right) => left - right)
  const rugCount = settled.filter((outcome) => outcome.rug).length
  const leadTimes = settled
    .map((outcome) => outcome.leadTimeHours)
    .filter((value): value is number => value !== undefined && Number.isFinite(value))
  const drawdowns = settled
    .map((outcome) => outcome.maxDrawdown)
    .filter((value): value is number => value !== undefined && Number.isFinite(value))

  const lastEligible = eligible.length === 0
    ? undefined
    : [...eligible].sort((a, b) => Date.parse(b.boughtAt) - Date.parse(a.boughtAt))[0]!.boughtAt
  const idleDays = lastEligible
    ? Math.max(0, (Date.parse(nowIso) - Date.parse(lastEligible)) / 86_400_000)
    : Number.POSITIVE_INFINITY

  const hitMean = settled.length === 0 ? 0 : hits.length / settled.length
  const medianExcess = median(excess)
  const rugExposure = settled.length === 0 ? 0 : rugCount / settled.length
  const coverage = eligible.length === 0 ? 0 : settled.length / eligible.length
  const distinctTokens = new Set(eligible.map((outcome) => outcome.tokenAddress)).size

  return {
    effectiveBuys: eligible.length,
    distinctTokens,
    settledBuys: settled.length,
    hits: hits.length,
    coverage,
    hitMean,
    hitLb95: wilsonLowerBound(hits.length, settled.length),
    medianExcess,
    rugExposure,
    idleDays: Number.isFinite(idleDays) ? idleDays : 1e9,
    leadTimeQuality: leadQuality(leadTimes),
    drawdownAndRugQuality: clamp01(1 - rugExposure - median(drawdowns) * 0.5),
    coverageDiversityActivity: clamp01(
      0.5 * coverage + 0.5 * Math.min(1, distinctTokens / 8),
    ),
    posteriorHitQuality: clamp01(hitMean),
    medianExcessQuality: clamp01(Math.max(0, medianExcess) / 0.5),
    ...(lastEligible ? { lastEligibleAt: lastEligible } : {}),
    scoreCutoff,
  }
}

export function performanceToEvidence(perf: WalletPerformance): WalletEvidence {
  return {
    posteriorHitQuality: perf.posteriorHitQuality,
    medianExcessQuality: perf.medianExcessQuality,
    leadTimeQuality: perf.leadTimeQuality,
    drawdownAndRugQuality: perf.drawdownAndRugQuality,
    coverageDiversityActivity: perf.coverageDiversityActivity,
  }
}

function leadQuality(hours: readonly number[]): number {
  if (hours.length === 0) return 0
  const early = hours.filter((h) => h >= 1).length
  return clamp01(early / hours.length)
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const middle = Math.floor(values.length / 2)
  if (values.length % 2 === 1) return values[middle]!
  return (values[middle - 1]! + values[middle]!) / 2
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}
