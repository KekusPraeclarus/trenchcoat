import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StateStore } from "../../src/lib/state.js"
import type { SourceCallOutcome } from "../../src/sources/outcomes.js"
import type { SourceLifecycleFile } from "../../src/contracts/schemas.js"

vi.mock("../../src/lib/config.js", () => ({
  loadConfig: () => ({
    twitter: {
      managed_list: { capacity: 50 },
      source_lifecycle: {
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
      },
    },
    audit: { source_score_prior_strength: 10 },
  }),
  saveConfig: vi.fn(),
}))

vi.mock("../../src/collectors/twitter/managed-list.js", () => ({
  syncManagedListMembership: vi.fn(),
  createManagedPrivateList: vi.fn(),
  confineListId: vi.fn(),
}))

describe("runSourceListReview lagged sources.json writes", () => {
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("writes applyLaggedScore for candidates with settledCalls > 0", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-src-score-"))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    mkdirSync(join(agentRoot, "state"), { recursive: true })
    mkdirSync(archiveRoot, { recursive: true })

    const lifecycle: SourceLifecycleFile = {
      schema: 1,
      candidates: [{
        schema: 1,
        sourceId: "x_alpha",
        handle: "alpha",
        status: "probation",
        firstSeenAt: "2026-06-01T00:00:00.000Z",
        lastSeenAt: "2026-07-10T00:00:00.000Z",
        discoveredFrom: "fyp",
        evidenceHash: "sha256:" + "a".repeat(64),
        consecutiveBelowFloorEpochs: 0,
        hardDocked: false,
      }],
      transitions: [],
      pendingTransitionIds: [],
    }
    writeFileSync(
      join(agentRoot, "state", "source-lifecycle.json"),
      `${JSON.stringify(lifecycle, null, 2)}\n`,
    )
    writeFileSync(
      join(agentRoot, "state", "sources.json"),
      `${JSON.stringify({ schema: 1, sources: [] }, null, 2)}\n`,
    )

    const outcomes: SourceCallOutcome[] = Array.from({ length: 3 }, (_, i) => ({
      eventId: `call-${i}`,
      sourceId: "x_alpha",
      tokenId: `tok_${i}`,
      mentionedAt: "2026-07-01T00:00:00.000Z",
      settledAt: "2026-07-04T00:00:00.000Z",
      excessReturn72h: 0.25,
      rug: false,
    }))

    const { runSourceListReview } = await import("../../src/orchestrator/source-list.js")
    await runSourceListReview({
      agentRoot,
      archiveRoot,
      sync: false,
      dryRun: false,
      outcomes,
      epochId: "test-epoch",
      nowIso: "2026-07-10T00:00:00.000Z",
    })

    const store = new StateStore(join(agentRoot, "state"))
    const sources = store.loadSources().sources
    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({
      sourceId: "x_alpha",
      handle: "alpha",
      platform: "x",
      docked: false,
    })
    expect(sources[0]!.score).toBeGreaterThan(0.5)
    expect(sources[0]!.scoreUpdatedAt).toBe("2026-07-10T00:00:00.000Z")
  })

  it("skips sources.json writes when settledCalls is 0", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-src-noscore-"))
    const agentRoot = join(root, "agent")
    const archiveRoot = join(root, "archive")
    mkdirSync(join(agentRoot, "state"), { recursive: true })
    mkdirSync(archiveRoot, { recursive: true })

    const lifecycle: SourceLifecycleFile = {
      schema: 1,
      candidates: [{
        schema: 1,
        sourceId: "x_beta",
        handle: "beta",
        status: "probation",
        firstSeenAt: "2026-06-01T00:00:00.000Z",
        lastSeenAt: "2026-07-10T00:00:00.000Z",
        discoveredFrom: "fyp",
        evidenceHash: "sha256:" + "b".repeat(64),
        consecutiveBelowFloorEpochs: 0,
        hardDocked: false,
      }],
      transitions: [],
      pendingTransitionIds: [],
    }
    writeFileSync(
      join(agentRoot, "state", "source-lifecycle.json"),
      `${JSON.stringify(lifecycle, null, 2)}\n`,
    )
    writeFileSync(
      join(agentRoot, "state", "sources.json"),
      `${JSON.stringify({ schema: 1, sources: [] }, null, 2)}\n`,
    )

    const { runSourceListReview } = await import("../../src/orchestrator/source-list.js")
    await runSourceListReview({
      agentRoot,
      archiveRoot,
      sync: false,
      dryRun: false,
      outcomes: [],
      epochId: "test-epoch-empty",
      nowIso: "2026-07-10T00:00:00.000Z",
    })

    const store = new StateStore(join(agentRoot, "state"))
    expect(store.loadSources().sources).toHaveLength(0)
  })
})
