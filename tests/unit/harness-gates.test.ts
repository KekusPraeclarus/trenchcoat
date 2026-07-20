import { describe, expect, it } from "vitest"
import { join } from "node:path"
import { extractJsonObject } from "../../src/harness/parse-json.js"
import { validateReviewApproval } from "../../src/harness/review-agent.js"
import { protectedMetricsUnchangedOrImproved } from "../../src/harness/quality.js"
import { isDrainClear, type DrainSnapshot } from "../../src/harness/drain.js"
import { confineDiff } from "../../src/harness/prepare.js"
import { DECISION_POLICY_REL_PATH, POLICY_ALLOWLIST } from "../../src/harness/paths.js"
import type { HarnessReview, Scorecard } from "../../src/contracts/schemas.js"

describe("harness parse-json", () => {
  it("extracts the first JSON object and rejects non-objects", () => {
    expect(extractJsonObject('noise {"a":1} trailing')).toEqual({ a: 1 })
    expect(() => extractJsonObject("no json here")).toThrow()
    expect(() => extractJsonObject("[1,2]")).toThrow()
  })
})

describe("harness review approval", () => {
  const baseFindings = {
    invariantFindings: [{ id: "INV-S24", pass: true, note: "ok" }],
    outputQualityPass: true,
    pipelineCompatible: true,
    evidenceSufficient: true,
    testCoverageAdequate: true,
    securitySurfaceOk: true,
    rollbackAdequate: true,
    uncertainty: [] as string[],
    rationale: "safe",
  }

  function review(over: Partial<HarnessReview> & { findings?: Partial<typeof baseFindings> }): HarnessReview {
    return {
      schema: 1,
      hypothesisId: "hyp-1",
      phase: "plan",
      createdAt: "2026-07-19T00:00:00.000Z",
      model: "composer-2.5",
      verdict: "approve",
      findings: { ...baseFindings, ...(over.findings ?? {}) },
      ...over,
    }
  }

  it("approves only when verdict approve, all findings pass, and uncertainty empty", () => {
    expect(validateReviewApproval(review({})).ok).toBe(true)
    expect(validateReviewApproval(review({ verdict: "reject" })).ok).toBe(false)
    expect(validateReviewApproval(review({
      findings: { ...baseFindings, uncertainty: ["unclear holdout"] },
    })).ok).toBe(false)
    expect(validateReviewApproval(review({
      findings: { ...baseFindings, outputQualityPass: false },
    })).ok).toBe(false)
  })
})

describe("harness quality", () => {
  function card(over: Partial<Scorecard>): Scorecard {
    return {
      schema: 1,
      epochId: "e1",
      sealedAt: "2026-07-19T00:00:00.000Z",
      manifestHash: `sha256:${"a".repeat(64)}`,
      paperPnlGross: 1,
      paperPnlCostAdjusted: 1,
      cohortExcess72h: { numerator: 1, denominator: 10, exclusions: 0, exclusionReasons: [] },
      hitRate: { numerator: 6, denominator: 10, exclusions: 0, exclusionReasons: [] },
      dropPrecision: { numerator: 0, denominator: 0, exclusions: 0, exclusionReasons: [] },
      ignoreMissRate: { numerator: 2, denominator: 10, exclusions: 0, exclusionReasons: [] },
      calibrationBrier: 0.2,
      broadcastPrecision: { numerator: 0, denominator: 0, exclusions: 0, exclusionReasons: [] },
      sourceCallCoverage: { numerator: 0, denominator: 0, exclusions: 0, exclusionReasons: [] },
      outcomeCoverage: { numerator: 10, denominator: 10, exclusions: 0, exclusionReasons: [] },
      rugExposure: { numerator: 1, denominator: 10, exclusions: 0, exclusionReasons: [] },
      costUsd: 0,
      failureCount: 0,
      ...over,
    }
  }

  it("rejects protected-metric regressions and inconclusive coverage tricks", () => {
    const baseline = card({})
    const improved = card({
      hitRate: { numerator: 8, denominator: 10, exclusions: 0, exclusionReasons: [] },
      paperPnlCostAdjusted: 2,
    })
    expect(protectedMetricsUnchangedOrImproved(baseline, improved, "hitRate").ok).toBe(true)

    const rugWorse = card({
      hitRate: { numerator: 8, denominator: 10, exclusions: 0, exclusionReasons: [] },
      rugExposure: { numerator: 5, denominator: 10, exclusions: 0, exclusionReasons: [] },
    })
    expect(protectedMetricsUnchangedOrImproved(baseline, rugWorse, "hitRate").ok).toBe(false)
  })
})

describe("harness confinement allowlist", () => {
  it("allows only the decision-policy path", () => {
    expect(confineDiff([DECISION_POLICY_REL_PATH], POLICY_ALLOWLIST).ok).toBe(true)
    expect(confineDiff(["agent/AGENTS.md"], POLICY_ALLOWLIST).ok).toBe(false)
    expect(confineDiff(["src/harness/schedule.ts"], POLICY_ALLOWLIST).ok).toBe(false)
  })
})

describe("harness drain predicate", () => {
  const clear: DrainSnapshot = {
    capturedAt: "2026-07-19T00:00:00.000Z",
    lockHeld: false,
    lockStale: false,
    incompleteRuns: 0,
    runningIncompleteRuns: 0,
    abandonedIncompleteRuns: 0,
    researchActionable: 0,
    researchResearching: 0,
    telegramPendingConfirm: false,
    telegramResearchRunning: false,
    alphaPendingOrProcessing: 0,
    discordLockHeld: false,
    discordWorkerLockHeld: false,
    discordQueued: 0,
    discordRunning: 0,
    discordUndeliveredCompleted: 0,
    chainIntegrationBusy: false,
    chainIntegrationDeploying: false,
    xPendingActions: 0,
    routerIngressPending: 0,
  }

  it("is clear only when every all-work condition passes", () => {
    expect(isDrainClear(clear)).toBe(true)
    expect(isDrainClear({ ...clear, researchResearching: 1 })).toBe(false)
    expect(isDrainClear({ ...clear, lockStale: true })).toBe(false)
    expect(isDrainClear({ ...clear, routerIngressPending: 2 })).toBe(false)
    expect(isDrainClear({ ...clear, alphaPendingOrProcessing: 3 })).toBe(false)
    expect(isDrainClear({ ...clear, abandonedIncompleteRuns: 5 })).toBe(true)
  })

  it("treats only in-flight work as blocking agent idle", async () => {
    const { isAgentIdle } = await import("../../src/harness/drain.js")
    expect(isAgentIdle(clear)).toBe(true)
    expect(isAgentIdle({ ...clear, lockHeld: true })).toBe(false)
    expect(isAgentIdle({ ...clear, runningIncompleteRuns: 1, incompleteRuns: 1 })).toBe(false)
    expect(isAgentIdle({ ...clear, researchResearching: 1 })).toBe(false)
    expect(isAgentIdle({ ...clear, telegramResearchRunning: true })).toBe(false)
    expect(isAgentIdle({ ...clear, discordRunning: 1 })).toBe(false)
    expect(isAgentIdle({ ...clear, discordLockHeld: true })).toBe(false)
    expect(isAgentIdle({ ...clear, chainIntegrationBusy: true })).toBe(false)
    expect(isAgentIdle({ ...clear, chainIntegrationDeploying: true })).toBe(true)
    expect(isAgentIdle({
      ...clear,
      abandonedIncompleteRuns: 10,
      researchActionable: 4,
      alphaPendingOrProcessing: 50,
      discordQueued: 2,
      xPendingActions: 1,
      routerIngressPending: 3,
      telegramPendingConfirm: true,
    })).toBe(true)
  })

  it("idle ignores backlog while drain still requires it", async () => {
    const { isAgentIdle } = await import("../../src/harness/drain.js")
    // Stale lock: idle predicate ignores it (held+not-stale blocks); drain fails closed
    expect(isAgentIdle({ ...clear, lockStale: true })).toBe(true)
    expect(isDrainClear({ ...clear, lockStale: true })).toBe(false)
    expect(isAgentIdle({ ...clear, lockHeld: true, lockStale: true })).toBe(true)
    expect(isAgentIdle({ ...clear, lockHeld: true, lockStale: false })).toBe(false)
  })
})

describe("decision-policy baseline artifact", () => {
  it("ships a parseable baseline policy in the repo", async () => {
    const { loadPolicy } = await import("../../src/harness/policy.js")
    const path = join(process.cwd(), "agent/skills/decision-policy/policy.json")
    const doc = loadPolicy(path)
    expect(doc.kind).toBe("baseline")
    expect(doc.allowlistPaths).toEqual([DECISION_POLICY_REL_PATH])
  })
})
