import { describe, expect, it } from "vitest"
import {
  registerFypCandidates,
  reviewSourceLifecycle,
  shouldPromoteSource,
  demotionReason,
  desiredManagedHandles,
  markHardDock,
  sourceIdForHandle,
  type SourceLifecycleThresholds,
} from "../../src/sources/lifecycle.js"
import type { SourceCandidate, SourceLifecycleFile, SourcePerformance } from "../../src/contracts/schemas.js"
import { sha256Json } from "../../src/lib/canonical-json.js"

const thresholds: SourceLifecycleThresholds = {
  max_transitions_per_review: 10,
  promotion: {
    min_eligible_calls: 10,
    min_distinct_tokens: 5,
    min_coverage: 0.80,
    min_hit_mean: 0.60,
    min_hit_lb95: 0.45,
    min_median_excess: 0.05,
    max_rug_exposure: 0.10,
    max_idle_days: 14,
  },
  demotion: {
    idle_days: 30,
    rug_exposure: 0.25,
    min_resolved_for_rug_drop: 4,
    coverage_floor: 0.50,
    score_floor: 0.40,
    consecutive_epochs: 2,
    readd_cooldown_days: 30,
    readd_min_new_calls: 5,
  },
}

function emptyFile(): SourceLifecycleFile {
  return {
    schema: 1,
    candidates: [],
    transitions: [],
    pendingTransitionIds: [],
  }
}

function candidate(partial: Partial<SourceCandidate> & Pick<SourceCandidate, "handle">): SourceCandidate {
  const handle = partial.handle
  const sourceId = partial.sourceId ?? sourceIdForHandle(handle)
  const { handle: _h, sourceId: _s, ...rest } = partial
  return {
    schema: 1,
    sourceId,
    handle,
    discoveredFrom: "fyp",
    firstSeenAt: "2026-06-01T00:00:00.000Z",
    lastSeenAt: "2026-07-01T00:00:00.000Z",
    status: "probation",
    consecutiveBelowFloorEpochs: 0,
    hardDocked: false,
    evidenceHash: sha256Json({ sourceId }),
    ...rest,
  }
}

function goodPerf(now = "2026-07-10T00:00:00.000Z"): SourcePerformance {
  return {
    eligibleCalls: 12,
    distinctTokens: 6,
    settledCalls: 11,
    hits: 8,
    coverage: 11 / 12,
    hitMean: 8 / 11,
    hitLb95: 0.46,
    medianExcess72h: 0.12,
    rugExposure: 0.05,
    lastEligibleCallAt: "2026-07-08T00:00:00.000Z",
    score: 0.7,
    scoreCutoff: now,
  }
}

describe("FYP candidacy", () => {
  it("registers only valid FYP handles as probation", () => {
    const next = registerFypCandidates(
      emptyFile(),
      ["Alice", "@Bob", "bad handle!", "Alice"],
      "2026-07-10T00:00:00.000Z",
    )
    expect(next.candidates).toHaveLength(2)
    expect(next.candidates.every((c) => c.status === "probation")).toBe(true)
    expect(next.candidates.every((c) => c.discoveredFrom === "fyp")).toBe(true)
  })

  it("does not invent operator-list promotions from registration alone", () => {
    const next = registerFypCandidates(emptyFile(), ["alpha"], "2026-07-10T00:00:00.000Z")
    expect(desiredManagedHandles(next)).toEqual([])
  })
})

describe("discovery origins", () => {
  it("accepts operator-list discovery for shill candidacy", async () => {
    const { registerDiscoveryCandidates } = await import("../../src/sources/lifecycle.js")
    const next = registerDiscoveryCandidates(
      emptyFile(),
      [{ handle: "alpha", origin: "operator-list-1" }],
      "2026-07-10T00:00:00.000Z",
    )
    expect(next.candidates[0]?.discoveredFrom).toBe("operator-list-1")
    expect(shouldPromoteSource(
      next.candidates[0]!,
      goodPerf(),
      "2026-07-10T00:00:00.000Z",
      thresholds,
    )).toBe(true)
  })
})

describe("promotion gate", () => {
  it("promotes when thresholds met", () => {
    const c = candidate({ handle: "alpha" })
    expect(shouldPromoteSource(c, goodPerf(), "2026-07-10T00:00:00.000Z", thresholds)).toBe(true)
  })

  it("rejects model-irrelevant weak scores", () => {
    const c = candidate({ handle: "alpha" })
    const weak = { ...goodPerf(), hitMean: 0.2, hitLb95: 0.1 }
    expect(shouldPromoteSource(c, weak, "2026-07-10T00:00:00.000Z", thresholds)).toBe(false)
  })

  it("enforces demotion cooldown and new-call requirement", () => {
    const c = candidate({
      handle: "alpha",
      status: "demoted",
      demotedAt: "2026-07-01T00:00:00.000Z",
      cooldownUntil: "2026-07-20T00:00:00.000Z",
      callsAtDemotion: 10,
    })
    expect(shouldPromoteSource(c, goodPerf(), "2026-07-10T00:00:00.000Z", thresholds)).toBe(false)
    const afterCooldown = candidate({
      ...c,
      cooldownUntil: "2026-07-01T00:00:00.000Z",
      callsAtDemotion: 10,
    })
    const notEnoughNew = { ...goodPerf(), eligibleCalls: 12 }
    expect(shouldPromoteSource(afterCooldown, notEnoughNew, "2026-07-10T00:00:00.000Z", thresholds)).toBe(false)
    const enoughNew = { ...goodPerf(), eligibleCalls: 16 }
    expect(shouldPromoteSource(afterCooldown, enoughNew, "2026-07-10T00:00:00.000Z", thresholds)).toBe(true)
  })
})

describe("demotion gate", () => {
  it("hard docks immediately", () => {
    const c = candidate({ handle: "alpha", status: "managed", hardDocked: true })
    expect(demotionReason(c, goodPerf(), "2026-07-10T00:00:00.000Z", thresholds)).toBe("hard_dock")
  })

  it("demotes on inactivity and rug exposure", () => {
    const c = candidate({ handle: "alpha", status: "managed" })
    const idle = { ...goodPerf(), lastEligibleCallAt: "2026-05-01T00:00:00.000Z" }
    expect(demotionReason(c, idle, "2026-07-10T00:00:00.000Z", thresholds)).toBe("inactive")
    const rug = {
      ...goodPerf(),
      settledCalls: 5,
      rugExposure: 0.4,
      lastEligibleCallAt: "2026-07-08T00:00:00.000Z",
    }
    expect(demotionReason(c, rug, "2026-07-10T00:00:00.000Z", thresholds)).toBe("rug_exposure")
  })

  it("requires two consecutive below-floor epochs", () => {
    const first = candidate({
      handle: "alpha",
      status: "managed",
      consecutiveBelowFloorEpochs: 1,
    })
    const weak = {
      ...goodPerf(),
      coverage: 0.2,
      score: 0.1,
      lastEligibleCallAt: "2026-07-08T00:00:00.000Z",
    }
    expect(demotionReason(first, weak, "2026-07-10T00:00:00.000Z", thresholds)).toBeUndefined()
    const second = { ...first, consecutiveBelowFloorEpochs: 2 }
    expect(demotionReason(second, weak, "2026-07-10T00:00:00.000Z", thresholds)).toBe("below_floor")
  })
})

describe("reviewSourceLifecycle", () => {
  it("caps transitions and keeps excess pending", () => {
    const file: SourceLifecycleFile = {
      schema: 1,
      candidates: Array.from({ length: 15 }, (_, i) => candidate({
        handle: `user${i}`,
        status: "probation",
      })),
      transitions: [],
      pendingTransitionIds: [],
    }
    const performances = new Map(
      file.candidates.map((c) => [c.sourceId, goodPerf()]),
    )
    const result = reviewSourceLifecycle({
      file,
      performances,
      epochId: "epoch-1",
      nowIso: "2026-07-10T00:00:00.000Z",
      thresholds: { ...thresholds, max_transitions_per_review: 10 },
      capacity: 250,
    })
    expect(result.applied).toHaveLength(10)
    expect(result.queued).toHaveLength(5)
    expect(result.file.candidates.filter((c) => c.status === "managed")).toHaveLength(10)
  })

  it("is idempotent for the same epoch evidence", () => {
    const file: SourceLifecycleFile = {
      schema: 1,
      candidates: [candidate({ handle: "alpha", status: "probation" })],
      transitions: [],
      pendingTransitionIds: [],
    }
    const performances = new Map([["x_alpha", goodPerf()]])
    const first = reviewSourceLifecycle({
      file,
      performances,
      epochId: "epoch-1",
      nowIso: "2026-07-10T00:00:00.000Z",
      thresholds,
      capacity: 250,
    })
    const second = reviewSourceLifecycle({
      file: first.file,
      performances,
      epochId: "epoch-1",
      nowIso: "2026-07-10T00:00:00.000Z",
      thresholds,
      capacity: 250,
    })
    expect(first.applied).toHaveLength(1)
    expect(second.applied).toHaveLength(0)
    expect(second.file.transitions).toHaveLength(1)
  })

  it("hard dock via markHardDock forces demotion", () => {
    let file: SourceLifecycleFile = {
      schema: 1,
      candidates: [candidate({ handle: "alpha", status: "managed" })],
      transitions: [],
      pendingTransitionIds: [],
    }
    file = markHardDock(file, "x_alpha", "2026-07-10T00:00:00.000Z")
    const result = reviewSourceLifecycle({
      file,
      performances: new Map([["x_alpha", goodPerf()]]),
      epochId: "epoch-2",
      nowIso: "2026-07-10T00:00:00.000Z",
      thresholds,
      capacity: 250,
    })
    expect(result.applied[0]?.action).toBe("demoted")
    expect(result.applied[0]?.reasonCode).toBe("hard_dock")
  })
})
