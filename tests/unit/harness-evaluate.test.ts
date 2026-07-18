import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureArchive } from "../../src/lib/archive.js"
import {
  beginEpochBuild,
  computeScorecard,
  materializeSyntheticOutcome,
  planAuditEpoch,
  sealEpoch,
} from "../../src/orchestrator/scorecard.js"
import { evaluateHypothesis } from "../../src/harness/evaluate.js"
import { saveHypothesis, hypothesisDir } from "../../src/harness/propose.js"
import { isHoldoutConsumed } from "../../src/harness/holdout-registry.js"
import { savePolicy } from "../../src/harness/policy.js"
import type { ReplaySubject } from "../../src/harness/replay.js"
import {
  DecisionPolicyDocumentSchema,
  HarnessHypothesisSchema,
} from "../../src/contracts/schemas.js"

const CONFIG_HASH = `sha256:${"c".repeat(64)}` as const
const COMMIT = "abcdef1234567"

async function sealEpochWithHits(
  archiveRoot: string,
  epochId: string,
  hits: number,
): Promise<void> {
  const layout = await ensureArchive(archiveRoot)
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
    subjects: [{ id: "decision-1", type: "decision", eventTimestamp: 1_000, horizonHours: 24 }],
  })
  await beginEpochBuild(layout, manifest)
  const decisions = Array.from({ length: 10 }, (_, i) => ({
    verdict: "track",
    confidence: 60,
    hit: i < hits,
    excess72h: i < hits ? 0.2 : 0,
  }))
  const scorecard = computeScorecard({
    epochId,
    sealedAt: "2026-07-16T00:00:00.000Z",
    manifestHash: manifest.manifestHash,
    decisions,
    broadcasts: [],
    sourceCalls: [],
    outcomes: Array.from({ length: 10 }, () => ({ status: "complete" })),
    rugs: Array.from({ length: 10 }, () => ({ rug: false })),
    paperPnlGross: 10,
    paperPnlCostAdjusted: 8,
  })
  await sealEpoch(layout, epochId, scorecard, "2026-07-16T00:00:00.000Z")
}

async function saveTestHypothesis(archiveRoot: string, hypothesisId: string): Promise<void> {
  await saveHypothesis(archiveRoot, HarnessHypothesisSchema.parse({
    schema: 1,
    hypothesisId,
    createdAt: "2026-07-16T01:00:00.000Z",
    epochId: "dev",
    manifestHash: `sha256:${"d".repeat(64)}`,
    primaryMetric: "hitRate",
    safetyFloors: {},
    allowlistPaths: ["agent/skills/**"],
    sampleRequirements: { minEvents: 1, minHoldoutEvents: 2 },
    rollbackConditions: ["rugExposure exceeds safety floor"],
    rationale: "test",
    status: "prepared",
  }))
}

function writeWorktreeMeta(archiveRoot: string, hypothesisId: string, worktreePath: string): void {
  writeFileSync(
    join(hypothesisDir(archiveRoot, hypothesisId), "worktree.json"),
    `${JSON.stringify({ worktreePath, branch: `harness/${hypothesisId}` }, null, 2)}\n`,
  )
}

// six tracked subjects with winning outcomes: candidate replay scores 6/6 hitRate
function trackingSubjects(): readonly ReplaySubject[] {
  return Array.from({ length: 6 }, (_, i) => ({
    subjectId: `hs-${i}`,
    subjectType: "decision" as const,
    horizonHours: 24,
    signals: { momentum: 1 },
    outcome: materializeSyntheticOutcome({
      subjectId: `hs-${i}`,
      subjectType: "decision",
      horizonHours: 24,
      eventTs: "2026-07-15T00:00:00.000Z",
      entryPrice: 1,
      exitPrice: 2,
      benchmarkReturn: 0,
      feeBpsPerSide: 10,
      observedAt: "2026-07-16T00:00:00.000Z",
    }),
  }))
}

async function writeCandidatePolicy(worktreePath: string): Promise<void> {
  await savePolicy(
    join(worktreePath, "agent", "skills", "decision-policy", "policy.json"),
    DecisionPolicyDocumentSchema.parse({
      schema: 1,
      policyVersion: "candidate:test",
      kind: "candidate",
      createdAt: "2026-07-16T01:00:00.000Z",
      weights: { momentum: 1 },
      thresholds: { track: 0.5, ignore: 0, drop: -0.5 },
    }),
  )
}

describe("evaluateHypothesis", () => {
  it("grades the candidate from a policy replay, not the holdout scorecard", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-eval-"))
    const archiveRoot = join(root, "archive")
    const worktreePath = join(root, "worktree")
    const hypothesisId = "hyp-eval-1"

    await sealEpochWithHits(archiveRoot, "dev", 1) // baseline hitRate 0.1
    await sealEpochWithHits(archiveRoot, "hold", 9) // holdout sealed hitRate 0.9
    await saveTestHypothesis(archiveRoot, hypothesisId)
    mkdirSync(worktreePath, { recursive: true })
    writeWorktreeMeta(archiveRoot, hypothesisId, worktreePath)
    await writeCandidatePolicy(worktreePath)

    const evaluation = await evaluateHypothesis({
      archiveRoot,
      hypothesisId,
      developmentEpochId: "dev",
      holdoutEpochId: "hold",
      repoRoot: root,
      nowIso: "2026-07-16T02:00:00.000Z",
      runTests: false,
      gitRevParse: () => COMMIT,
      loadHoldoutSubjects: () => trackingSubjects(),
    })

    expect(evaluation.candidateCommit).toBe(COMMIT)
    expect(evaluation.metrics["baseline"]).toBeCloseTo(0.1, 6)
    // candidate replay is 6/6 = 1, distinct from the holdout's sealed 0.9
    expect(evaluation.metrics["candidate"]).toBeCloseTo(1, 6)
    expect(evaluation.metrics["holdoutN"]).toBe(6)
    expect(evaluation.primaryImproved).toBe(true)
    expect(evaluation.safetyFloorsPassed).toBe(true)
    expect(evaluation.holdoutConsumed).toBe(true)
    expect(isHoldoutConsumed(archiveRoot, "hold")).toBe(true)
  })

  it("rejects reuse of an already-consumed holdout", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-eval-"))
    const archiveRoot = join(root, "archive")
    const worktreePath = join(root, "worktree")
    const hypothesisId = "hyp-eval-2"

    await sealEpochWithHits(archiveRoot, "dev", 1)
    await sealEpochWithHits(archiveRoot, "hold", 9)
    await saveTestHypothesis(archiveRoot, hypothesisId)
    mkdirSync(worktreePath, { recursive: true })
    writeWorktreeMeta(archiveRoot, hypothesisId, worktreePath)
    await writeCandidatePolicy(worktreePath)

    const opts = {
      archiveRoot,
      hypothesisId,
      developmentEpochId: "dev",
      holdoutEpochId: "hold",
      repoRoot: root,
      nowIso: "2026-07-16T02:00:00.000Z",
      runTests: false,
      gitRevParse: () => COMMIT,
      loadHoldoutSubjects: () => trackingSubjects(),
    }
    await evaluateHypothesis(opts)
    await expect(evaluateHypothesis(opts)).rejects.toThrow(/already consumed/u)
  })

  it("fails closed and never consumes the holdout when the policy file is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-eval-"))
    const archiveRoot = join(root, "archive")
    const worktreePath = join(root, "worktree")
    const hypothesisId = "hyp-eval-3"

    await sealEpochWithHits(archiveRoot, "dev", 1)
    await sealEpochWithHits(archiveRoot, "hold", 9)
    await saveTestHypothesis(archiveRoot, hypothesisId)
    mkdirSync(worktreePath, { recursive: true })
    writeWorktreeMeta(archiveRoot, hypothesisId, worktreePath)

    const evaluation = await evaluateHypothesis({
      archiveRoot,
      hypothesisId,
      developmentEpochId: "dev",
      holdoutEpochId: "hold",
      repoRoot: root,
      nowIso: "2026-07-16T02:00:00.000Z",
      runTests: false,
      gitRevParse: () => COMMIT,
    })

    expect(evaluation.rejectReason).toMatch(/policy file missing/u)
    expect(evaluation.holdoutConsumed).toBe(false)
    expect(evaluation.candidateCommit).toBe(COMMIT)
    expect(isHoldoutConsumed(archiveRoot, "hold")).toBe(false)
  })
})
