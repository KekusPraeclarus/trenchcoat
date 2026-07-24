import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureArchive } from "../../src/lib/archive.js"
import {
  beginEpochBuild,
  computeScorecard,
  planAuditEpoch,
  sealEpoch,
} from "../../src/orchestrator/scorecard.js"
import { proposeFromSealedEpoch } from "../../src/harness/propose.js"
import { startCanary, stopCanary, promoteHypothesis } from "../../src/harness/lifecycle.js"
import { writeAtomicFile } from "../../src/lib/fs-atomic.js"
import { HarnessEvaluationSchema } from "../../src/contracts/schemas.js"
import { hypothesisDir, saveHypothesis } from "../../src/harness/propose.js"
import { runHarnessImprove } from "../../src/harness/schedule.js"
import { ConfigSchema } from "../../src/lib/config.js"
import { migrateConfigToV21 } from "../../src/migrations/config.js"

const CONFIG_HASH = `sha256:${"c".repeat(64)}` as const

async function sealFixture(archiveRoot: string, epochId: string, hitRate: number): Promise<void> {
  const layout = await ensureArchive(archiveRoot)
  const hits = Math.round(hitRate * 10)
  const manifest = planAuditEpoch({
    epochId,
    previousEpochId: null,
    startedAt: 200_000,
    cutoffTimestamp: 109_000,
    settlementDelayHours: 6,
    priorSourceScoreCutoff: 90_000,
    configHash: CONFIG_HASH,
    featureSpecVersion: 1,
    executionModelVersion: 1,
    codeCommit: "abcdef1",
    subjects: [{
      id: "decision-1",
      type: "decision",
      eventTimestamp: 1_000,
      horizonHours: 24,
    }],
  })
  await beginEpochBuild(layout, manifest)
  const decisions = Array.from({ length: 10 }, (_, i) => ({
    verdict: "track",
    confidence: 60,
    hit: i < hits,
    excess72h: i < hits ? 0.25 : -0.1,
  }))
  const scorecard = computeScorecard({
    epochId,
    sealedAt: "2026-07-16T00:00:00.000Z",
    manifestHash: manifest.manifestHash,
    decisions,
    broadcasts: [],
    sourceCalls: Array.from({ length: 10 }, () => ({ settled: true })),
    outcomes: Array.from({ length: 10 }, () => ({ status: "complete" })),
    rugs: Array.from({ length: 10 }, () => ({ rug: false })),
    paperPnlGross: hitRate * 100,
    paperPnlCostAdjusted: hitRate * 80,
  })
  await sealEpoch(layout, epochId, scorecard, "2026-07-16T00:00:00.000Z")
}

function writeEnabledConfig(trenchcoatDir: string): void {
  mkdirSync(trenchcoatDir, { recursive: true })
  const raw = migrateConfigToV21({
    schema: 4,
    telegram_channels: [],
    twitter: {
      operator_list_urls: ["https://x.com/i/lists/1", "https://x.com/i/lists/2"],
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
  })
  const parsed = ConfigSchema.parse(raw)
  parsed.harness_improvement.enabled = true
  parsed.harness_improvement.schedule_enabled = true
  parsed.harness_improvement.require_two_epochs = false
  parsed.harness_improvement.auto_open_pr = true
  writeFileSync(join(trenchcoatDir, "config.json"), `${JSON.stringify(parsed, null, 2)}\n`)
}

describe("harness propose/canary lifecycle", () => {
  it("proposes from sealed epoch and supports start/stop/promote", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-harness-"))
    const archiveRoot = join(root, "archive")
    await sealFixture(archiveRoot, "audit-dev", 0.3)
    const hyp = await proposeFromSealedEpoch({
      archiveRoot,
      epochId: "audit-dev",
      nowIso: "2026-07-16T01:00:00.000Z",
      minEvents: 5,
      minHoldoutEvents: 5,
    })
    expect(hyp.status).toBe("proposed")
    expect(hyp.primaryMetric).toBeTruthy()

    await saveHypothesis(archiveRoot, { ...hyp, status: "evaluated" })
    await writeAtomicFile(
      join(hypothesisDir(archiveRoot, hyp.hypothesisId), "evaluation.json"),
      `${JSON.stringify(HarnessEvaluationSchema.parse({
        schema: 1,
        hypothesisId: hyp.hypothesisId,
        evaluatedAt: "2026-07-16T02:00:00.000Z",
        baselineCommit: "abcdef1",
        candidateCommit: "abcdef2",
        developmentEpochId: "audit-dev",
        holdoutEpochId: "audit-hold",
        testsPassed: true,
        confinementPassed: true,
        primaryImproved: true,
        safetyFloorsPassed: true,
        holdoutConsumed: true,
        metrics: { baseline: 0.3, candidate: 0.7, holdoutN: 20 },
      }), null, 2)}\n`,
    )

    const canary = await startCanary({
      archiveRoot,
      hypothesisId: hyp.hypothesisId,
      allocationBps: 1_000,
      policyVersion: `candidate:${hyp.hypothesisId}`,
      nowIso: "2026-07-16T03:00:00.000Z",
    })
    expect(canary.active).toBe(true)

    const stopped = await stopCanary({
      archiveRoot,
      reason: "test rollback",
      nowIso: "2026-07-16T04:00:00.000Z",
    })
    expect(stopped.active).toBe(false)
    expect(stopped.stopReason).toBe("test rollback")

    await saveHypothesis(archiveRoot, { ...hyp, status: "evaluated" })
    await writeAtomicFile(
      join(hypothesisDir(archiveRoot, hyp.hypothesisId), "evaluation.json"),
      `${JSON.stringify(HarnessEvaluationSchema.parse({
        schema: 1,
        hypothesisId: hyp.hypothesisId,
        evaluatedAt: "2026-07-16T05:00:00.000Z",
        baselineCommit: "abcdef1",
        candidateCommit: "abcdef2",
        developmentEpochId: "audit-dev",
        holdoutEpochId: "audit-hold",
        testsPassed: true,
        confinementPassed: true,
        primaryImproved: true,
        safetyFloorsPassed: true,
        holdoutConsumed: true,
        metrics: { baseline: 0.3, candidate: 0.7, holdoutN: 20 },
      }), null, 2)}\n`,
    )
    await startCanary({
      archiveRoot,
      hypothesisId: hyp.hypothesisId,
      allocationBps: 1_000,
      policyVersion: `candidate:${hyp.hypothesisId}`,
    })
    await promoteHypothesis({
      archiveRoot,
      hypothesisId: hyp.hypothesisId,
      minMaturePaired: 0,
    })
  })
})

describe("prop_inv_s24_schedule_journal_idempotency", () => {
  it("skips schedule when sealed epochs lack decision-time signals", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-harness-sched-"))
    const archiveRoot = join(root, "archive")
    const home = join(root, "home")
    writeEnabledConfig(join(home, ".trenchcoat"))
    const prevHome = process.env["HOME"]
    process.env["HOME"] = home

    try {
      await sealFixture(archiveRoot, "audit-a", 0.5)
      await sealFixture(archiveRoot, "audit-b", 0.6)

      const repoRoot = join(root, "repo")
      mkdirSync(repoRoot, { recursive: true })
      mkdirSync(join(repoRoot, ".git"), { recursive: true })
      writeFileSync(join(repoRoot, "package.json"), `${JSON.stringify({
        name: "trenchcoat",
        private: true,
      }, null, 2)}\n`)

      const report = await runHarnessImprove({
        archiveRoot,
        repoRoot,
        dryRun: true,
        runTests: false,
      })
      expect(report.status).toBe("skipped")
      expect(report.reason).toMatch(/decision-time signals/u)
    } finally {
      if (prevHome === undefined) delete process.env["HOME"]
      else process.env["HOME"] = prevHome
    }
  })
})
