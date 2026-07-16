import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StateStore } from "../../src/lib/state.js"
import {
  registerFypCandidates,
  reviewSourceLifecycle,
  desiredManagedHandles,
  type SourceLifecycleThresholds,
} from "../../src/sources/lifecycle.js"
import { aggregateSourcePerformance, type SourceCallOutcome } from "../../src/sources/outcomes.js"
import { syncManagedListMembership } from "../../src/collectors/twitter/managed-list.js"
import { sha256Json } from "../../src/lib/canonical-json.js"

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

describe("integration source lifecycle pipeline", () => {
  it("collector candidacy → settled outcomes → transition → sync", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-src-life-"))
    mkdirSync(join(root, "state"), { recursive: true })
    const state = new StateStore(join(root, "state"))

    let file = registerFypCandidates(
      state.loadSourceLifecycle(),
      ["alpha"],
      "2026-06-01T00:00:00.000Z",
    )
    await state.saveSourceLifecycle(file)

    const outcomes: SourceCallOutcome[] = Array.from({ length: 12 }, (_, i) => ({
      eventId: `call-${i}`,
      sourceId: "x_alpha",
      tokenId: `tok_${i % 6}`,
      mentionedAt: `2026-07-${String(1 + (i % 7)).padStart(2, "0")}T00:00:00.000Z`,
      settledAt: `2026-07-${String(2 + (i % 7)).padStart(2, "0")}T12:00:00.000Z`,
      excessReturn72h: i === 0 ? -0.05 : 0.25,
      rug: false,
    }))

    const cutoff = "2026-07-10T00:00:00.000Z"
    const perf = aggregateSourcePerformance("x_alpha", outcomes, cutoff)
    expect(perf.eligibleCalls).toBeGreaterThanOrEqual(10)

    file = state.loadSourceLifecycle()
    const review = reviewSourceLifecycle({
      file,
      performances: new Map([["x_alpha", perf]]),
      epochId: "epoch-int-1",
      nowIso: cutoff,
      thresholds,
      capacity: 250,
    })
    expect(review.applied).toHaveLength(1)
    expect(review.applied[0]?.action).toBe("promoted")
    await state.saveSourceLifecycle(review.file)

    const members = new Set<string>()
    const sync = await syncManagedListMembership({
      managedListId: "999",
      desiredHandles: desiredManagedHandles(review.file),
      maxTransitions: 10,
      nowIso: cutoff,
      driver: {
        scrapeMembers: async () => [...members],
        addMember: async (_id, handle) => { members.add(handle.toLowerCase()) },
        removeMember: async (_id, handle) => { members.delete(handle.toLowerCase()) },
      },
    })
    expect(sync.receipt.verified).toBe(true)
    expect(members.has("alpha")).toBe(true)

    // crash/retry: re-review same epoch produces no duplicate transitions
    const retry = reviewSourceLifecycle({
      file: review.file,
      performances: new Map([["x_alpha", perf]]),
      epochId: "epoch-int-1",
      nowIso: cutoff,
      thresholds,
      capacity: 250,
    })
    expect(retry.applied).toHaveLength(0)
    expect(retry.file.transitions).toHaveLength(1)
    expect(retry.file.transitions[0]?.transitionId).toBe(review.applied[0]?.transitionId)
  })
})

describe("crash journal boundary for lifecycle state", () => {
  it("atomic save leaves valid JSON after rewrite", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-src-crash-"))
    mkdirSync(join(root, "state"), { recursive: true })
    const state = new StateStore(join(root, "state"))
    const first = registerFypCandidates(
      state.loadSourceLifecycle(),
      ["one"],
      "2026-07-01T00:00:00.000Z",
    )
    await state.saveSourceLifecycle(first)
    const second = registerFypCandidates(first, ["two"], "2026-07-02T00:00:00.000Z")
    await state.saveSourceLifecycle(second)
    const raw = readFileSync(join(root, "state", "source-lifecycle.json"), "utf8")
    const parsed = JSON.parse(raw) as { candidates: unknown[] }
    expect(parsed.candidates).toHaveLength(2)
    // evidence hashes remain content addressed
    expect(second.candidates[0]?.evidenceHash.startsWith("sha256:")).toBe(true)
    expect(sha256Json({ ok: true }).startsWith("sha256:")).toBe(true)
  })
})
