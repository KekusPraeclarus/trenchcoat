import { describe, expect, it } from "vitest"
import {
  reviewSourceLifecycle,
  type SourceLifecycleThresholds,
} from "../../src/sources/lifecycle.js"
import { sha256Json } from "../../src/lib/canonical-json.js"
import type { SourceLifecycleFile, SourcePerformance } from "../../src/contracts/schemas.js"

const thresholds: SourceLifecycleThresholds = {
  max_transitions_per_review: 10,
  promotion: {
    min_eligible_calls: 10,
    min_distinct_tokens: 5,
    min_coverage: 0.8,
    min_hit_mean: 0.6,
    min_hit_lb95: 0.45,
    min_median_excess: 0.05,
    max_rug_exposure: 0.1,
    max_idle_days: 14,
  },
  demotion: {
    idle_days: 30,
    rug_exposure: 0.25,
    min_resolved_for_rug_drop: 4,
    coverage_floor: 0.5,
    score_floor: 0.4,
    consecutive_epochs: 2,
    readd_cooldown_days: 30,
    readd_min_new_calls: 5,
  },
}

const perf: SourcePerformance = {
  eligibleCalls: 12,
  distinctTokens: 6,
  settledCalls: 11,
  hits: 9,
  coverage: 0.9,
  hitMean: 0.8,
  hitLb95: 0.5,
  medianExcess72h: 0.1,
  rugExposure: 0,
  lastEligibleCallAt: "2026-07-08T00:00:00.000Z",
  score: 0.75,
  scoreCutoff: "2026-07-10T00:00:00.000Z",
}

describe("crash source-lifecycle transitions", () => {
  it("retries at review boundary yield one logical membership change", () => {
    const base: SourceLifecycleFile = {
      schema: 1,
      candidates: [{
        schema: 1,
        sourceId: "x_alpha",
        handle: "alpha",
        discoveredFrom: "fyp",
        firstSeenAt: "2026-06-01T00:00:00.000Z",
        lastSeenAt: "2026-07-01T00:00:00.000Z",
        status: "probation",
        consecutiveBelowFloorEpochs: 0,
        hardDocked: false,
        evidenceHash: sha256Json({ sourceId: "x_alpha" }),
      }],
      transitions: [],
      pendingTransitionIds: [],
    }

    let file = base
    for (let i = 0; i < 5; i += 1) {
      const result = reviewSourceLifecycle({
        file,
        performances: new Map([["x_alpha", perf]]),
        epochId: "epoch-crash",
        nowIso: "2026-07-10T00:00:00.000Z",
        thresholds,
        capacity: 250,
      })
      file = result.file
    }

    expect(file.transitions).toHaveLength(1)
    expect(file.candidates[0]?.status).toBe("managed")
    expect(new Set(file.pendingTransitionIds).size).toBe(file.pendingTransitionIds.length)
  })
})
