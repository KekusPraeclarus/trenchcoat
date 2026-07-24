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
import { savePolicy } from "../../src/harness/policy.js"
import { DecisionPolicyDocumentSchema } from "../../src/contracts/schemas.js"
import { proposeMetaCandidateFromPrior } from "../../src/harness/meta-propose.js"
import {
  listTrials,
  loadUtility,
  nudgePolicyForWeakness,
  recomputeAndSaveUtility,
  runMetaTrialPair,
} from "../../src/harness/meta-trial.js"
import { isHoldoutConsumed } from "../../src/harness/holdout-registry.js"
import { DEFAULT_IMPROVER_CONFIG, saveImproverConfig } from "../../src/harness/improver-config.js"
import type { ReplaySubject } from "../../src/harness/replay.js"

const CONFIG_HASH = `sha256:${"a".repeat(64)}` as const

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

function trackingSubjects(): readonly ReplaySubject[] {
  return Array.from({ length: 6 }, (_, i) => ({
    subjectId: `hs-${i}`,
    subjectType: "decision" as const,
    horizonHours: 24,
    signals: { confidence: 1 },
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

describe("meta improver-config lane", () => {
  it("nudgePolicyForWeakness returns a schema-valid candidate policy", () => {
    const base = DecisionPolicyDocumentSchema.parse({
      schema: 1,
      policyVersion: "baseline",
      kind: "baseline",
      createdAt: "2026-07-16T00:00:00.000Z",
      weights: { confidence: 0.2 },
      thresholds: { track: 0.5, ignore: 0, drop: -0.5 },
    })
    const nudged = nudgePolicyForWeakness(base, "hitRate")
    expect(nudged.kind).toBe("candidate")
    expect(nudged.thresholds["track"]).toBeGreaterThan(0.5)
  })

  it("runs a shadow paired meta trial and consumes the holdout", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-meta-"))
    const archiveRoot = join(root, "archive")
    const repoRoot = join(root, "repo")
    mkdirSync(join(repoRoot, "agent/skills/decision-policy"), { recursive: true })
    mkdirSync(join(repoRoot, "config"), { recursive: true })
    await saveImproverConfig(repoRoot, DEFAULT_IMPROVER_CONFIG)
    await savePolicy(
      join(repoRoot, "agent/skills/decision-policy/policy.json"),
      DecisionPolicyDocumentSchema.parse({
        schema: 1,
        policyVersion: "baseline",
        kind: "baseline",
        createdAt: "2026-07-16T00:00:00.000Z",
        weights: { confidence: 1 },
        thresholds: { track: 0.5, ignore: 0, drop: -0.5 },
      }),
    )
    // minimal package.json + .git marker for assertRepoRoot if schedule used later
    writeFileSync(join(repoRoot, "package.json"), "{}\n")
    mkdirSync(join(repoRoot, ".git"), { recursive: true })

    await sealEpochWithHits(archiveRoot, "dev", 1)
    await sealEpochWithHits(archiveRoot, "hold", 9)

    const candidate = await proposeMetaCandidateFromPrior({
      archiveRoot,
      repoRoot,
      nowIso: "2026-07-16T02:00:00.000Z",
      candidateId: "mc-shadow-1",
    })
    expect(candidate.status).toBe("proposed")
    expect(candidate.candidateId).toBe("mc-shadow-1")

    const pair = await runMetaTrialPair({
      archiveRoot,
      repoRoot,
      candidateId: candidate.candidateId,
      developmentEpochId: "dev",
      holdoutEpochId: "hold",
      nowIso: "2026-07-16T03:00:00.000Z",
      loadHoldoutSubjects: () => trackingSubjects(),
    })

    expect(pair.holdoutConsumed).toBe(true)
    expect(pair.winner).toMatch(/baseline|candidate|tie/u)
    expect(isHoldoutConsumed(archiveRoot, "hold")).toBe(true)
    expect(listTrials(archiveRoot, candidate.candidateId)).toHaveLength(1)

    const again = await runMetaTrialPair({
      archiveRoot,
      repoRoot,
      candidateId: candidate.candidateId,
      developmentEpochId: "dev",
      holdoutEpochId: "hold",
      nowIso: "2026-07-16T04:00:00.000Z",
      trialId: pair.trialId,
      loadHoldoutSubjects: () => trackingSubjects(),
    })
    expect(again.trialId).toBe(pair.trialId)

    const utility = await recomputeAndSaveUtility({
      archiveRoot,
      candidateId: candidate.candidateId,
      nowIso: "2026-07-16T04:00:00.000Z",
    })
    expect(utility.validPairs).toBe(1)
    expect(utility.promotionEligible).toBe(false)
    expect(loadUtility(archiveRoot, candidate.candidateId)?.validPairs).toBe(1)
  })
})
