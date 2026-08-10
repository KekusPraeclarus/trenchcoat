import { describe, expect, it } from "vitest"
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureArchive } from "../../src/lib/archive.js"
import {
  assessHarnessImproveReadiness,
  harnessStatusSnapshot,
  type HarnessImproveConfigSlice,
} from "../../src/harness/readiness.js"
import { recordHoldoutConsumption } from "../../src/harness/holdout-registry.js"
import { saveHypothesis, hypothesisDir } from "../../src/harness/propose.js"
import {
  makeDecisionBundle,
  sealScorecardEpoch,
  seedDecisionWithOutcome,
} from "../helpers/harness-archive.js"
import { writeDecisionBundle } from "../../src/orchestrator/scorecard.js"
import { HarnessHypothesisSchema } from "../../src/contracts/schemas.js"
import { saveMetaCandidate } from "../../src/harness/meta-trial.js"

const BASE_CONFIG: HarnessImproveConfigSlice = {
  enabled: true,
  schedule_enabled: true,
  require_two_epochs: true,
  one_active_experiment: true,
  min_events: 10,
  min_holdout_events: 1,
}

async function sealWithSignals(
  archiveRoot: string,
  epochId: string,
  decisionId: string,
): Promise<void> {
  await sealScorecardEpoch({
    archiveRoot,
    epochId,
    hits: 7,
    subjects: [{ id: decisionId }],
  })
  const layout = await ensureArchive(archiveRoot)
  await seedDecisionWithOutcome({
    layout,
    decisionId,
    excessReturn: 0.2,
    signals: { confidence: 60, clusters: 1 },
  })
}

function snapshotFiles(root: string): string {
  const walk = (dir: string, acc: string[] = []): string[] => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, name.name)
      if (name.isDirectory()) walk(path, acc)
      else acc.push(path.slice(root.length + 1))
    }
    return acc.sort()
  }
  return walk(root).join("\n")
}

describe("assessHarnessImproveReadiness", () => {
  it("is ready for a distinct signalled unused epoch pair meeting floors", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-ready-"))
    const archiveRoot = join(root, "archive")
    await sealWithSignals(archiveRoot, "audit-a", "dec-a")
    await sealWithSignals(archiveRoot, "audit-b", "dec-b")
    const before = snapshotFiles(root)

    const readiness = assessHarnessImproveReadiness({
      archiveRoot,
      config: BASE_CONFIG,
    })

    expect(readiness.ready).toBe(true)
    expect(readiness.developmentEpochId).toBe("audit-a")
    expect(readiness.holdoutEpochId).toBe("audit-b")
    expect(readiness.reasonSlug).toBeUndefined()
    expect(snapshotFiles(root)).toBe(before)
  })

  it("skips when require_two_epochs and only one sealed epoch exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-one-"))
    const archiveRoot = join(root, "archive")
    await sealWithSignals(archiveRoot, "audit-only", "dec-1")
    const before = snapshotFiles(root)

    const readiness = assessHarnessImproveReadiness({
      archiveRoot,
      config: BASE_CONFIG,
    })

    expect(readiness.ready).toBe(false)
    expect(readiness.reasonSlug).toBe("distinct-epochs")
    expect(readiness.reason).toMatch(/require_two_epochs/u)
    expect(readiness.nextAction).toMatch(/second distinct sealed audit epoch/u)
    expect(snapshotFiles(root)).toBe(before)
  })

  it("skips when schedule_enabled is false", () => {
    const root = mkdtempSync(join(tmpdir(), "tc-sched-off-"))
    const archiveRoot = join(root, "archive")
    mkdirSync(archiveRoot, { recursive: true })
    const readiness = assessHarnessImproveReadiness({
      archiveRoot,
      config: { ...BASE_CONFIG, schedule_enabled: false },
    })
    expect(readiness.ready).toBe(false)
    expect(readiness.reasonSlug).toBe("schedule-enabled")
  })

  it("skips when holdout is already consumed", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-consumed-"))
    const archiveRoot = join(root, "archive")
    await sealWithSignals(archiveRoot, "audit-a", "dec-a")
    await sealWithSignals(archiveRoot, "audit-b", "dec-b")
    await recordHoldoutConsumption({
      archiveRoot,
      consumption: {
        schema: 1,
        epochId: "audit-b",
        hypothesisId: "hyp-1",
        consumedAt: "2026-07-16T00:00:00.000Z",
        candidateCommit: "abcdef1",
      },
    })

    const readiness = assessHarnessImproveReadiness({
      archiveRoot,
      config: BASE_CONFIG,
    })

    expect(readiness.ready).toBe(false)
    expect(readiness.reasonSlug).toBe("holdout-unused")
    expect(readiness.reason).toMatch(/already consumed/u)
  })

  it("skips when development sample is below min_events", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-floor-"))
    const archiveRoot = join(root, "archive")
    await sealWithSignals(archiveRoot, "audit-a", "dec-a")
    await sealWithSignals(archiveRoot, "audit-b", "dec-b")

    const readiness = assessHarnessImproveReadiness({
      archiveRoot,
      config: { ...BASE_CONFIG, min_events: 40 },
    })

    expect(readiness.ready).toBe(false)
    expect(readiness.reasonSlug).toBe("dev-sample-floor")
  })

  it("skips when holdout subject count is below min_holdout_events", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-holdout-floor-"))
    const archiveRoot = join(root, "archive")
    await sealWithSignals(archiveRoot, "audit-a", "dec-a")
    await sealWithSignals(archiveRoot, "audit-b", "dec-b")

    const readiness = assessHarnessImproveReadiness({
      archiveRoot,
      config: { ...BASE_CONFIG, min_holdout_events: 5 },
    })

    expect(readiness.ready).toBe(false)
    expect(readiness.reasonSlug).toBe("holdout-sample-floor")
  })

  it("skips when decision-time signals are missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-nosig-"))
    const archiveRoot = join(root, "archive")
    await sealScorecardEpoch({
      archiveRoot,
      epochId: "audit-a",
      subjects: [{ id: "dec-a" }],
    })
    await sealScorecardEpoch({
      archiveRoot,
      epochId: "audit-b",
      subjects: [{ id: "dec-b" }],
    })

    const readiness = assessHarnessImproveReadiness({
      archiveRoot,
      config: BASE_CONFIG,
    })

    expect(readiness.ready).toBe(false)
    expect(readiness.reasonSlug).toBe("dev-signals")
  })

  it("skips when a policy hypothesis is mid-flight", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-mid-"))
    const archiveRoot = join(root, "archive")
    await sealWithSignals(archiveRoot, "audit-a", "dec-a")
    await sealWithSignals(archiveRoot, "audit-b", "dec-b")
    const hyp = HarnessHypothesisSchema.parse({
      schema: 1,
      hypothesisId: "hyp-mid",
      createdAt: "2026-07-16T00:00:00.000Z",
      epochId: "audit-a",
      manifestHash: `sha256:${"a".repeat(64)}`,
      primaryMetric: "hitRate",
      safetyFloors: { rugExposure: 0.25 },
      allowlistPaths: ["agent/skills/decision-policy/policy.json"],
      sampleRequirements: { minEvents: 10, minHoldoutEvents: 1 },
      rollbackConditions: ["protected metric regression"],
      rationale: "test mid-flight",
      status: "activation_pending",
    })
    mkdirSync(hypothesisDir(archiveRoot, hyp.hypothesisId), { recursive: true })
    await saveHypothesis(archiveRoot, hyp)

    const readiness = assessHarnessImproveReadiness({
      archiveRoot,
      config: BASE_CONFIG,
    })

    expect(readiness.ready).toBe(false)
    expect(readiness.reasonSlug).toBe("no-policy-midflight")
  })

  it("skips when a meta candidate is trialing", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-meta-mid-"))
    const archiveRoot = join(root, "archive")
    await sealWithSignals(archiveRoot, "audit-a", "dec-a")
    await sealWithSignals(archiveRoot, "audit-b", "dec-b")
    await saveMetaCandidate(archiveRoot, {
      schema: 1,
      candidateId: "meta-1",
      createdAt: "2026-07-16T00:00:00.000Z",
      status: "trialing",
      baseConfigHash: `sha256:${"a".repeat(64)}`,
      candidateConfigHash: `sha256:${"b".repeat(64)}`,
      rationale: "test trialing",
    })

    const readiness = assessHarnessImproveReadiness({
      archiveRoot,
      config: BASE_CONFIG,
    })

    expect(readiness.ready).toBe(false)
    expect(readiness.reasonSlug).toBe("no-meta-trialing")
  })

  it("exposes pending activation nextAction in status snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-status-"))
    const archiveRoot = join(root, "archive")
    await sealWithSignals(archiveRoot, "audit-a", "dec-a")
    await sealWithSignals(archiveRoot, "audit-b", "dec-b")
    const hyp = HarnessHypothesisSchema.parse({
      schema: 1,
      hypothesisId: "hyp-act",
      createdAt: "2026-07-16T00:00:00.000Z",
      epochId: "audit-a",
      manifestHash: `sha256:${"a".repeat(64)}`,
      primaryMetric: "hitRate",
      safetyFloors: { rugExposure: 0.25 },
      allowlistPaths: ["agent/skills/decision-policy/policy.json"],
      sampleRequirements: { minEvents: 10, minHoldoutEvents: 1 },
      rollbackConditions: ["protected metric regression"],
      rationale: "test pending",
      status: "activation_pending",
    })
    mkdirSync(hypothesisDir(archiveRoot, hyp.hypothesisId), { recursive: true })
    await saveHypothesis(archiveRoot, hyp)

    const snap = harnessStatusSnapshot({
      archiveRoot,
      config: BASE_CONFIG,
    })
    expect(snap.pendingActivation?.hypothesisId).toBe("hyp-act")
    expect(snap.nextAction).toBe("tc harness activate hyp-act")
  })
})

describe("readiness signal fixture helper", () => {
  it("writes decision bundles without mutating readiness", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-bundle-"))
    const archiveRoot = join(root, "archive")
    const layout = await ensureArchive(archiveRoot)
    await writeDecisionBundle(layout, makeDecisionBundle({
      decisionId: "dec-x",
      signals: { confidence: 1 },
    }))
    expect(existsSync(join(layout.decisions, "dec-x.json"))).toBe(true)
    expect(JSON.parse(readFileSync(join(layout.decisions, "dec-x.json"), "utf8")).signals)
      .toEqual({ confidence: 1 })
  })
})
