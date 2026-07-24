import {
  HarnessManifestoValidationSchema,
  HarnessProtectedDirectionSchema,
  PROTECTED_QUALITY_METRICS,
  isHarnessPlanV2,
  type HarnessManifestoValidation,
  type HarnessPlan,
} from "../contracts/schemas.js"
import type { z } from "zod"

type ProtectedDirection = z.infer<typeof HarnessProtectedDirectionSchema>

function lowerIsBetter(metric: string): boolean {
  return metric === "ignoreMissRate"
    || metric === "calibrationBrier"
    || metric === "rugExposure"
}

function measuredDirection(
  metric: string,
  baseline: number,
  candidate: number,
  epsilon = 1e-9,
): ProtectedDirection {
  const delta = candidate - baseline
  if (Math.abs(delta) <= epsilon) return "hold"
  if (lowerIsBetter(metric)) {
    return delta < 0 ? "improve" : "worsen"
  }
  return delta > 0 ? "improve" : "worsen"
}

function isRegression(metric: string, baseline: number, candidate: number): boolean {
  return measuredDirection(metric, baseline, candidate) === "worsen"
}

/**
 * Compare plan manifesto predictions to measured baseline/candidate metrics.
 * Unpredicted protected regression → ok:false. Prediction misses without
 * regression are recorded but do not hard-fail primary gates.
 */
export function validateManifestoAgainstEvaluation(
  plan: HarnessPlan,
  metrics: Readonly<Record<string, number>>,
  opts: Readonly<{
    hypothesisId: string
    validatedAt: string
  }>,
): HarnessManifestoValidation {
  if (!isHarnessPlanV2(plan)) {
    return HarnessManifestoValidationSchema.parse({
      schema: 1,
      hypothesisId: opts.hypothesisId,
      validatedAt: opts.validatedAt,
      ok: true,
      predictions: [],
      unpredictedRegressions: [],
      predictionMisses: [],
    })
  }

  const predictions: HarnessManifestoValidation["predictions"] = []
  const unpredictedRegressions: HarnessManifestoValidation["unpredictedRegressions"] = []
  const predictionMisses: HarnessManifestoValidation["predictionMisses"] = []

  const predictedWorse = new Set(
    plan.atRiskRegressions.map((r) => r.metric),
  )

  for (const metric of PROTECTED_QUALITY_METRICS) {
    const baseline = metrics[`protectedBaseline_${metric}`]
    const candidate = metrics[`protectedCandidate_${metric}`]
    if (!Number.isFinite(baseline) || !Number.isFinite(candidate)) continue

    const measured = measuredDirection(metric, baseline!, candidate!)
    const predicted = plan.expectedProtectedDirections[metric] ?? "hold"
    const matched = predicted === measured
    predictions.push({
      metric,
      predicted,
      measured,
      matched,
      baseline: baseline!,
      candidate: candidate!,
    })

    if (isRegression(metric, baseline!, candidate!)) {
      const allowed = predicted === "worsen" || predictedWorse.has(metric)
      if (!allowed) {
        unpredictedRegressions.push({
          metric,
          baseline: baseline!,
          candidate: candidate!,
        })
      }
    } else if (!matched && predicted !== "hold") {
      predictionMisses.push({ metric, predicted, measured })
    }
  }

  return HarnessManifestoValidationSchema.parse({
    schema: 1,
    hypothesisId: opts.hypothesisId,
    validatedAt: opts.validatedAt,
    ok: unpredictedRegressions.length === 0,
    predictions,
    unpredictedRegressions,
    predictionMisses,
  })
}
