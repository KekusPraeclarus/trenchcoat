import {
  MetaUtilitySummarySchema,
  type MetaTrialPair,
  type MetaUtilitySummary,
} from "../contracts/schemas.js"

/** Host-owned, non-configurable (ADR 039) */
export const META_MIN_VALID_PAIRS = 8
export const META_MIN_CANDIDATE_WINS = 5

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2
  }
  return sorted[mid]
}

/**
 * Candidate becomes promotion_eligible only when:
 * ≥8 valid pairs; candidate ≥5 wins; candidate win rate > baseline;
 * protected-regression and invalid counts no worse; median signed primary
 * improvement positive and no worse than baseline; no safety/integrity failure.
 * Ties count for neither side.
 */
export function computeMetaUtility(opts: Readonly<{
  candidateId: string
  nowIso: string
  pairs: readonly MetaTrialPair[]
  safetyIntegrityOk?: boolean
}>): MetaUtilitySummary {
  const safetyIntegrityOk = opts.safetyIntegrityOk !== false
  const completed = opts.pairs.filter(
    (p) => p.winner !== undefined && p.holdoutConsumed,
  )
  const valid = completed.filter((p) => !p.baselineInvalid && !p.candidateInvalid)
  const candidateWins = valid.filter((p) => p.winner === "candidate").length
  const baselineWins = valid.filter((p) => p.winner === "baseline").length
  const ties = valid.filter((p) => p.winner === "tie").length
  const denom = candidateWins + baselineWins
  const candidateWinRate = denom === 0 ? 0 : candidateWins / denom
  const baselineWinRate = denom === 0 ? 0 : baselineWins / denom

  const candidateProtected = valid.reduce(
    (n, p) => n + p.candidateProtectedRegressions,
    0,
  )
  const baselineProtected = valid.reduce(
    (n, p) => n + p.baselineProtectedRegressions,
    0,
  )
  const candidateInvalidCount = completed.filter((p) => p.candidateInvalid).length
  const baselineInvalidCount = completed.filter((p) => p.baselineInvalid).length

  const candidateDeltas = valid
    .map((p) => p.candidatePrimaryDelta)
    .filter((n): n is number => Number.isFinite(n))
  const baselineDeltas = valid
    .map((p) => p.baselinePrimaryDelta)
    .filter((n): n is number => Number.isFinite(n))
  const medianCandidate = median(candidateDeltas)
  const medianBaseline = median(baselineDeltas)

  const reasons: string[] = []
  if (!safetyIntegrityOk) reasons.push("safety-integrity")
  if (valid.length < META_MIN_VALID_PAIRS) reasons.push("insufficient-pairs")
  if (candidateWins < META_MIN_CANDIDATE_WINS) reasons.push("insufficient-wins")
  if (!(candidateWinRate > baselineWinRate)) reasons.push("win-rate")
  if (candidateProtected > baselineProtected) reasons.push("protected-regressions")
  if (candidateInvalidCount > baselineInvalidCount) reasons.push("invalid-count")
  if (medianCandidate === undefined || !(medianCandidate > 0)) {
    reasons.push("median-primary")
  } else if (
    medianBaseline !== undefined
    && medianCandidate < medianBaseline
  ) {
    reasons.push("median-worse-than-baseline")
  }

  const promotionEligible = reasons.length === 0

  return MetaUtilitySummarySchema.parse({
    schema: 1,
    candidateId: opts.candidateId,
    computedAt: opts.nowIso,
    validPairs: valid.length,
    candidateWins,
    baselineWins,
    ties,
    candidateWinRate,
    baselineWinRate,
    candidateProtectedRegressions: candidateProtected,
    baselineProtectedRegressions: baselineProtected,
    candidateInvalidCount,
    baselineInvalidCount,
    ...(medianCandidate !== undefined
      ? { medianCandidatePrimaryDelta: medianCandidate }
      : {}),
    ...(medianBaseline !== undefined
      ? { medianBaselinePrimaryDelta: medianBaseline }
      : {}),
    safetyIntegrityOk,
    promotionEligible,
    ...(promotionEligible ? {} : { rejectReason: reasons.join("; ").slice(0, 280) }),
  })
}
