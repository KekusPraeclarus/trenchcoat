import { describe, expect, it } from "vitest"
import * as fc from "fast-check"
import {
  registerDiscoveryCandidates,
  registerFypCandidates,
  reviewSourceLifecycle,
  type SourceLifecycleThresholds,
} from "../../src/sources/lifecycle.js"
import { computeMembershipDiff } from "../../src/collectors/twitter/managed-list.js"
import { migrateConfigToV20 } from "../../src/migrations/config.js"
import { ConfigSchema } from "../../src/lib/config.js"
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

describe("prop_inv_s21_fyp_only_candidacy", () => {
  it("only stores normalized handles from discovery registration", () => {
    fc.assert(fc.property(
      fc.array(fc.string({ minLength: 1, maxLength: 20 }), { maxLength: 30 }),
      (authors) => {
        const file = registerFypCandidates(
          { schema: 1, candidates: [], transitions: [], pendingTransitionIds: [] },
          authors,
          "2026-07-10T00:00:00.000Z",
        )
        return file.candidates.every((c) => (
          (c.discoveredFrom === "fyp"
            || c.discoveredFrom === "operator-list-1"
            || c.discoveredFrom === "operator-list-2"
            || c.discoveredFrom === "fomo-leaderboard")
          && c.status === "probation"
          && /^[A-Za-z0-9_]{1,15}$/u.test(c.handle)
        ))
      },
    ))
  })

  it("accepts fomo-leaderboard origin for registerDiscoveryCandidates", () => {
    const file = registerDiscoveryCandidates(
      { schema: 1, candidates: [], transitions: [], pendingTransitionIds: [] },
      [{ handle: "Alpha", origin: "fomo-leaderboard" }],
      "2026-07-10T00:00:00.000Z",
    )
    expect(file.candidates[0]?.discoveredFrom).toBe("fomo-leaderboard")
  })
})

describe("prop_inv_s21_transition_idempotency", () => {
  it("re-running the same review never duplicates transition ids", () => {
    const file: SourceLifecycleFile = {
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
    const perf: SourcePerformance = {
      eligibleCalls: 12,
      distinctTokens: 6,
      settledCalls: 11,
      hits: 8,
      coverage: 0.9,
      hitMean: 0.7,
      hitLb95: 0.5,
      medianExcess72h: 0.1,
      rugExposure: 0,
      lastEligibleCallAt: "2026-07-08T00:00:00.000Z",
      score: 0.7,
      scoreCutoff: "2026-07-10T00:00:00.000Z",
    }
    const first = reviewSourceLifecycle({
      file,
      performances: new Map([["x_alpha", perf]]),
      epochId: "e1",
      nowIso: "2026-07-10T00:00:00.000Z",
      thresholds,
      capacity: 10,
    })
    const second = reviewSourceLifecycle({
      file: first.file,
      performances: new Map([["x_alpha", perf]]),
      epochId: "e1",
      nowIso: "2026-07-10T00:00:00.000Z",
      thresholds,
      capacity: 10,
    })
    const ids = second.file.transitions.map((t) => t.transitionId)
    expect(new Set(ids).size).toBe(ids.length)
    expect(second.applied).toHaveLength(0)
  })
})

describe("prop membership diff commutative", () => {
  it("diff then apply yields desired set", () => {
    fc.assert(fc.property(
      fc.uniqueArray(fc.stringMatching(/^[a-z]{3,8}$/u), { maxLength: 8 }),
      fc.uniqueArray(fc.stringMatching(/^[a-z]{3,8}$/u), { maxLength: 8 }),
      (current, desired) => {
        const diff = computeMembershipDiff(current, desired)
        const next = new Set(current.map((h) => h.toLowerCase()))
        for (const h of diff.toRemove) next.delete(h)
        for (const h of diff.toAdd) next.add(h)
        const want = new Set(desired.map((h) => h.toLowerCase()))
        return next.size === want.size && [...next].every((h) => want.has(h))
      },
    ))
  })
})

describe("config migration v5", () => {
  it("lifts single curated list into two operator slots with harness defaults", () => {
    const v5 = migrateConfigToV20({
      schema: 2,
      twitter: {
        curated_list_url: "https://x.com/i/lists/111",
        scrape_home: true,
        max_pages_per_run: 5,
      },
      telegram_channels: [],
      research: {},
      broadcast: {},
      indicators: {},
      gate_thresholds: {},
      audit: { rsi_promotion: {} },
      wallets: {
        deterministic_weight: 0.8,
        llm_weight: 0.2,
        promotion: {},
        drop: {},
      },
      source_safety: {},
      retention: {},
      chat: {},
      router: {},
    })
    const parsed = ConfigSchema.parse(v5)
    expect(parsed.schema).toBe(20)
    expect(parsed.twitter.operator_list_urls[0]).toBe("https://x.com/i/lists/111")
    expect(parsed.twitter.engagement.enabled).toBe(true)
    expect(parsed.harness_improvement.enabled).toBe(false)
    expect(parsed.farcaster.enabled).toBe(false)
    expect(parsed.narratives.retention_days).toBe(14)
  })
})
