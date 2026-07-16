import { wilsonLowerBound } from "../orchestrator/audit-math.js"
import {
  initialSourceScore,
  observeHit,
  meanScore,
} from "../lib/source-scoring.js"
import type { SourcePerformance } from "../contracts/schemas.js"

export type SourceCallOutcome = Readonly<{
  eventId: string
  sourceId: string
  tokenId: string
  mentionedAt: string
  settledAt?: string
  excessReturn72h?: number
  rug: boolean
}>

export function aggregateSourcePerformance(
  sourceId: string,
  outcomes: readonly SourceCallOutcome[],
  scoreCutoff: string,
  priorStrength = 10,
): SourcePerformance {
  const cutoffMs = Date.parse(scoreCutoff)
  if (!Number.isFinite(cutoffMs)) throw new TypeError("Invalid score cutoff")

  const deduped = new Map<string, SourceCallOutcome>()
  for (const outcome of outcomes) {
    if (outcome.sourceId !== sourceId) continue
    if (Date.parse(outcome.mentionedAt) >= cutoffMs) continue
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

  let scoreState = initialSourceScore(priorStrength)
  for (const outcome of settled) {
    scoreState = observeHit(
      scoreState,
      outcome.excessReturn72h! >= 0.20,
      Date.parse(outcome.settledAt!),
    )
  }

  return {
    eligibleCalls: eligible.length,
    distinctTokens: new Set(eligible.map((outcome) => outcome.tokenId)).size,
    settledCalls: settled.length,
    hits: hits.length,
    coverage: eligible.length === 0 ? 0 : settled.length / eligible.length,
    hitMean: settled.length === 0 ? 0 : hits.length / settled.length,
    hitLb95: wilsonLowerBound(hits.length, settled.length),
    medianExcess72h: median(excess),
    rugExposure: settled.length === 0 ? 0 : rugCount / settled.length,
    ...(eligible.length > 0
      ? {
          lastEligibleCallAt: [...eligible]
            .sort((left, right) => Date.parse(right.mentionedAt) - Date.parse(left.mentionedAt))[0]!
            .mentionedAt,
        }
      : {}),
    score: meanScore(scoreState),
    scoreCutoff,
  }
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const middle = Math.floor(values.length / 2)
  if (values.length % 2 === 1) return values[middle]!
  return (values[middle - 1]! + values[middle]!) / 2
}
