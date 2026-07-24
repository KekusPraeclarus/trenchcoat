import { describe, expect, it } from "vitest"
import {
  HarnessImproverConfigSchema,
  HarnessPlanSchema,
  isHarnessPlanV2,
} from "../../src/contracts/schemas.js"
import { validateManifestoAgainstEvaluation } from "../../src/harness/manifesto-validate.js"

const basePlan = {
  schema: 2 as const,
  hypothesisId: "hyp-1",
  createdAt: "2026-07-16T00:00:00.000Z",
  model: "composer-2.5",
  baseCommit: "abcdef1234567",
  developmentEpochId: "dev",
  holdoutEpochId: "hold",
  currentWeakness: "track-miss association",
  primaryMetric: "hitRate",
  proposedPolicyChanges: "nudge track threshold",
  expectedPrimaryEffect: "raise hitRate",
  expectedProtectedEffects: {
    hitRate: "improve",
    ignoreMissRate: "hold",
    calibrationBrier: "hold",
    paperPnlCostAdjusted: "hold",
    rugExposure: "hold",
    outcomeCoverage: "hold",
  },
  expectedProtectedDirections: {
    hitRate: "improve" as const,
    ignoreMissRate: "hold" as const,
    calibrationBrier: "hold" as const,
    paperPnlCostAdjusted: "hold" as const,
    rugExposure: "hold" as const,
    outcomeCoverage: "hold" as const,
  },
  evidenceIds: ["d-1"],
  rootCauseHypothesis: "associated with mid confidence track misses",
  predictedFixes: [{ target: "thresholds.track", change: "raise slightly" }],
  atRiskRegressions: [],
  preservedBehaviorIds: ["keep-1"],
  applicableInvariants: [],
  pipelineStagesAffected: [],
  failureModes: [],
  validationCases: [],
  rollbackConditions: ["rugExposure exceeds safety floor"],
  currentPolicyHash: `sha256:${"a".repeat(64)}`,
  scorecardSummaryHash: `sha256:${"b".repeat(64)}`,
}

describe("manifesto-validate", () => {
  it("parses plan v2 and rejects improver config unknown keys", () => {
    const plan = HarnessPlanSchema.parse(basePlan)
    expect(isHarnessPlanV2(plan)).toBe(true)
    expect(() => HarnessImproverConfigSchema.parse({
      ...HarnessImproverConfigSchema.parse({
        schema: 1,
        configVersion: "x",
        mining: {
          minClusterSize: 5,
          maxClusters: 8,
          maxKeepPatterns: 3,
          maxEvidencePerPattern: 16,
          signalKeyPrefixes: ["confidence"],
        },
        propose: {
          weakMetricPriority: { hitRate: 1 },
          maxRationaleChars: 500,
        },
        planAddendum: "",
        test_command: "true",
      }),
    })).toThrow()
  })

  it("fails on unpredicted protected regression", () => {
    const plan = HarnessPlanSchema.parse(basePlan)
    const result = validateManifestoAgainstEvaluation(plan, {
      protectedBaseline_hitRate: 0.5,
      protectedCandidate_hitRate: 0.6,
      protectedBaseline_rugExposure: 0.1,
      protectedCandidate_rugExposure: 0.3,
      protectedBaseline_ignoreMissRate: 0.2,
      protectedCandidate_ignoreMissRate: 0.2,
      protectedBaseline_calibrationBrier: 0.2,
      protectedCandidate_calibrationBrier: 0.2,
      protectedBaseline_paperPnlCostAdjusted: 1,
      protectedCandidate_paperPnlCostAdjusted: 1,
      protectedBaseline_outcomeCoverage: 0.9,
      protectedCandidate_outcomeCoverage: 0.9,
    }, {
      hypothesisId: "hyp-1",
      validatedAt: "2026-07-16T00:00:00.000Z",
    })
    expect(result.ok).toBe(false)
    expect(result.unpredictedRegressions.some((r) => r.metric === "rugExposure")).toBe(true)
  })

  it("records prediction misses without regression as non-fatal", () => {
    const plan = HarnessPlanSchema.parse({
      ...basePlan,
      expectedProtectedDirections: {
        ...basePlan.expectedProtectedDirections,
        hitRate: "worsen",
      },
    })
    const result = validateManifestoAgainstEvaluation(plan, {
      protectedBaseline_hitRate: 0.5,
      protectedCandidate_hitRate: 0.6,
      protectedBaseline_rugExposure: 0.1,
      protectedCandidate_rugExposure: 0.1,
      protectedBaseline_ignoreMissRate: 0.2,
      protectedCandidate_ignoreMissRate: 0.2,
      protectedBaseline_calibrationBrier: 0.2,
      protectedCandidate_calibrationBrier: 0.2,
      protectedBaseline_paperPnlCostAdjusted: 1,
      protectedCandidate_paperPnlCostAdjusted: 1,
      protectedBaseline_outcomeCoverage: 0.9,
      protectedCandidate_outcomeCoverage: 0.9,
    }, {
      hypothesisId: "hyp-1",
      validatedAt: "2026-07-16T00:00:00.000Z",
    })
    expect(result.ok).toBe(true)
    expect(result.predictionMisses.length).toBeGreaterThan(0)
  })
})
