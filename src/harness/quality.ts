import {
  PROTECTED_QUALITY_METRICS,
  type Scorecard,
} from "../contracts/schemas.js"
import {
  checkSafetyFloors,
  primaryImproved,
} from "./evaluate.js"

export { checkSafetyFloors, primaryImproved }

function metricValue(scorecard: Scorecard, key: string): number {
  switch (key) {
    case "hitRate":
      return scorecard.hitRate.denominator === 0
        ? 0
        : scorecard.hitRate.numerator / scorecard.hitRate.denominator
    case "ignoreMissRate":
      return scorecard.ignoreMissRate.denominator === 0
        ? 0
        : scorecard.ignoreMissRate.numerator / scorecard.ignoreMissRate.denominator
    case "calibrationBrier":
      return scorecard.calibrationBrier ?? 1
    case "paperPnlCostAdjusted":
      return scorecard.paperPnlCostAdjusted
    case "rugExposure":
      return scorecard.rugExposure.denominator === 0
        ? 0
        : scorecard.rugExposure.numerator / scorecard.rugExposure.denominator
    case "outcomeCoverage":
      return scorecard.outcomeCoverage.denominator === 0
        ? 0
        : scorecard.outcomeCoverage.numerator / scorecard.outcomeCoverage.denominator
    default:
      return Number.NaN
  }
}

function lowerIsBetter(metric: string): boolean {
  return metric === "ignoreMissRate"
    || metric === "calibrationBrier"
    || metric === "rugExposure"
}

function denominator(scorecard: Scorecard, metric: string): number | undefined {
  switch (metric) {
    case "hitRate":
      return scorecard.hitRate.denominator
    case "ignoreMissRate":
      return scorecard.ignoreMissRate.denominator
    case "rugExposure":
      return scorecard.rugExposure.denominator
    case "outcomeCoverage":
      return scorecard.outcomeCoverage.denominator
    default:
      return undefined
  }
}

export type ProtectedMetricsCheck = Readonly<{
  ok: boolean
  regressions: readonly string[]
}>

/**
 * Candidate must not regress any protected metric other than the primary.
 * Rate metrics require matching denominators before comparison.
 * Inconclusive (NaN / denominator mismatch) does not pass.
 */
export function protectedMetricsUnchangedOrImproved(
  baseline: Scorecard,
  candidate: Scorecard,
  primaryMetric: string,
): ProtectedMetricsCheck {
  const regressions: string[] = []
  for (const metric of PROTECTED_QUALITY_METRICS) {
    if (metric === primaryMetric) continue
    const base = metricValue(baseline, metric)
    const cand = metricValue(candidate, metric)
    if (!Number.isFinite(base) || !Number.isFinite(cand)) {
      regressions.push(`${metric}:inconclusive`)
      continue
    }
    const baseN = denominator(baseline, metric)
    const candN = denominator(candidate, metric)
    if (baseN !== undefined && candN !== undefined && baseN !== candN) {
      // Outcome coverage / rates cannot improve by dropping hard cases
      if (metric === "outcomeCoverage" || metric === "hitRate" || metric === "ignoreMissRate") {
        regressions.push(`${metric}:denominator-mismatch:${baseN}->${candN}`)
        continue
      }
    }
    if (lowerIsBetter(metric)) {
      if (!(cand <= base)) regressions.push(`${metric}:${base}->${cand}`)
    } else if (!(cand >= base)) {
      regressions.push(`${metric}:${base}->${cand}`)
    }
  }
  return { ok: regressions.length === 0, regressions }
}
