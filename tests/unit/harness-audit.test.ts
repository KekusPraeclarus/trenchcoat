import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureArchive, archiveLayout } from "../../src/lib/archive.js"
import {
  beginEpochBuild,
  computeScorecard,
  planAuditEpoch,
  sealEpoch,
  loadSealedEpoch,
  verifySealedRerun,
  writeOutcomeObservation,
  materializeSyntheticOutcome,
} from "../../src/orchestrator/scorecard.js"
import { assignEpisode } from "../../src/harness/canary.js"
import { confineDiff } from "../../src/harness/prepare.js"
import { checkSafetyFloors, primaryImproved } from "../../src/harness/evaluate.js"
import { shouldStopCanary } from "../../src/harness/lifecycle.js"
import { migrateConfigToV22 } from "../../src/migrations/config.js"
import { ConfigSchema } from "../../src/lib/config.js"

const CONFIG_HASH = `sha256:${"b".repeat(64)}` as const

describe("audit spine", () => {
  it("seals an epoch with a scorecard and verifies rerun identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-audit-"))
    const layout = await ensureArchive(join(root, "archive"))
    const subject = {
      id: "decision-1",
      type: "decision" as const,
      eventTimestamp: 1_000,
      horizonHours: 24,
    }
    const manifest = planAuditEpoch({
      epochId: "audit-2026-W29",
      previousEpochId: null,
      startedAt: 200_000,
      cutoffTimestamp: 109_000,
      settlementDelayHours: 6,
      priorSourceScoreCutoff: 90_000,
      configHash: CONFIG_HASH,
      featureSpecVersion: 1,
      executionModelVersion: 1,
      codeCommit: "abcdef1",
      subjects: [subject],
    })
    await beginEpochBuild(layout, manifest)
    const obs = materializeSyntheticOutcome({
      subjectId: "decision-1",
      subjectType: "decision",
      horizonHours: 72,
      eventTs: "2026-07-01T00:00:00.000Z",
      entryPrice: 1,
      exitPrice: 1.3,
      benchmarkReturn: 0.05,
      feeBpsPerSide: 50,
      observedAt: "2026-07-04T00:00:00.000Z",
    })
    await writeOutcomeObservation(layout, obs)
    const scorecard = computeScorecard({
      epochId: "audit-2026-W29",
      sealedAt: "2026-07-16T00:00:00.000Z",
      manifestHash: manifest.manifestHash,
      decisions: [{
        verdict: "track",
        confidence: 70,
        hit: true,
        ...(obs.excessReturn !== undefined ? { excess72h: obs.excessReturn } : {}),
      }],
      broadcasts: [{ precise: true }],
      sourceCalls: [{ settled: true }],
      outcomes: [{ status: "complete" }],
      rugs: [{ rug: false }],
      paperPnlGross: 100,
      paperPnlCostAdjusted: 80,
    })
    const status = await sealEpoch(
      layout,
      "audit-2026-W29",
      scorecard,
      "2026-07-16T00:00:00.000Z",
    )
    expect(status.status).toBe("sealed")
    const loaded = loadSealedEpoch(layout, "audit-2026-W29")
    expect(loaded.scorecard.hitRate.numerator).toBe(1)
    verifySealedRerun(manifest, loaded.manifest)
  })
})

describe("harness gates", () => {
  it("assigns episodes deterministically by hash", () => {
    const active = {
      schema: 1 as const,
      hypothesisId: "hyp-1",
      policyVersion: "candidate:hyp-1",
      allocationBps: 1_000,
      startedAt: "2026-07-16T00:00:00.000Z",
      assignedEpisodes: 0,
      maturePaired: 0,
      active: true,
    }
    const a = assignEpisode("episode-alpha", 1_000, active)
    const b = assignEpisode("episode-alpha", 1_000, active)
    expect(a).toBe(b)
    const sample = Array.from({ length: 200 }, (_, i) => assignEpisode(`ep-${i}`, 1_000, active))
    const candidates = sample.filter((x) => x === "candidate").length
    expect(candidates).toBeGreaterThan(5)
    expect(candidates).toBeLessThan(60)
  })

  it("confines patches to allowlisted decision-policy paths", () => {
    const ok = confineDiff(
      ["agent/skills/research/SKILL.md", "agent/AGENTS.md"],
      ["agent/skills/**", "agent/AGENTS.md"],
    )
    expect(ok.ok).toBe(true)
    const bad = confineDiff(
      ["src/router/server.ts", "agent/skills/x.md"],
      ["agent/skills/**"],
    )
    expect(bad.ok).toBe(false)
    expect(bad.violations.some((v) => v.includes("router"))).toBe(true)
  })

  it("requires safety floors and primary improvement", () => {
    const scorecard = computeScorecard({
      epochId: "e",
      sealedAt: "2026-07-16T00:00:00.000Z",
      manifestHash: CONFIG_HASH,
      decisions: [
        { verdict: "track", confidence: 60, hit: true, excess72h: 0.2 },
        { verdict: "track", confidence: 60, hit: true, excess72h: 0.3 },
      ],
      broadcasts: [],
      sourceCalls: [],
      outcomes: [{ status: "complete" }, { status: "complete" }],
      rugs: [{ rug: false }, { rug: false }],
      paperPnlGross: 10,
      paperPnlCostAdjusted: 8,
    })
    expect(checkSafetyFloors(scorecard, { rugExposureMax: 0.25, outcomeCoverageMin: 0.5 }).ok).toBe(true)
    expect(primaryImproved("hitRate", 0.4, 0.9, 20, 18)).toBe(true)
    expect(primaryImproved("ignoreMissRate", 0.5, 0.2, 10, 2)).toBe(true)
    expect(primaryImproved("hitRate", 0.8, 0.7, 20, 14)).toBe(false)
  })

  it("stops canaries on integrity or rug floor breach", () => {
    expect(shouldStopCanary({
      rugExposure: 0.4,
      rugFloor: 0.25,
      candidateErrors: 0,
      errorBudget: 3,
      missingness: 0,
      missingnessMax: 0.3,
      sequentialRegressions: 0,
      integrityFailure: false,
    }).shouldStop).toBe(true)
    expect(shouldStopCanary({
      rugExposure: 0,
      rugFloor: 0.25,
      candidateErrors: 0,
      errorBudget: 3,
      missingness: 0,
      missingnessMax: 0.3,
      sequentialRegressions: 0,
      integrityFailure: true,
    }).reason).toBe("integrity failure")
  })

  it("migrates config to v5 with harness defaults disabled", () => {
    const v5 = ConfigSchema.parse(migrateConfigToV22({
      schema: 4,
      telegram_channels: [],
      twitter: {
        operator_list_urls: [
          "https://x.com/i/lists/1",
          "https://x.com/i/lists/2",
        ],
        scrape_home: true,
        max_pages_per_run: 5,
        managed_list: { name: "x", description: "y", capacity: 10 },
        source_lifecycle: {
          review_interval_hours: 24,
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
        engagement: { enabled: true, likes_per_window: 2, like_window_minutes: 10 },
      },
      research: {},
      broadcast: {},
      indicators: {},
      gate_thresholds: {},
      audit: { rsi_promotion: {} },
      wallets: { deterministic_weight: 0.8, llm_weight: 0.2, promotion: {}, drop: {} },
      source_safety: {},
      retention: {},
      chat: {},
      router: {},
    }))
    expect(v5.schema).toBe(22)
    expect(v5.harness_improvement.enabled).toBe(false)
    expect(v5.harness_improvement.allocation_bps).toBe(1_000)
    expect(v5.narratives.retention_days).toBe(14)
  })
})

void archiveLayout
