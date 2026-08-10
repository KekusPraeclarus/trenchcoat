import { describe, expect, it, beforeEach } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  applyFeedbackCandidate,
  buildFeedbackCandidate,
  checkCandidateConfinement,
  dismissFeedbackCandidate,
  evaluateFeedbackCandidate,
  hasKnownSignalPrefix,
  proposePolicyAdjustment,
  splitPreferenceSet,
  FeedbackApplyError,
  MAX_CHANGED_RULES,
} from "../../src/broadcast-feedback/candidate.js"
import { broadcastFeedbackLayout } from "../../src/broadcast-feedback/paths.js"
import type {
  DecisionPolicyDocument,
  FeedbackPolicyExample,
  OperatorPreferenceSet,
  SealedFeedbackDataset,
} from "../../src/contracts/schemas.js"

const BASELINE: DecisionPolicyDocument = {
  schema: 1,
  policyVersion: "baseline",
  kind: "baseline",
  createdAt: "2026-07-19T00:00:00.000Z",
  weights: {},
  thresholds: { track: 0.5, ignore: 0, drop: -0.5 },
  rules: [],
  allowlistPaths: ["agent/skills/decision-policy/policy.json"],
}

function example(overrides: Partial<FeedbackPolicyExample> & Readonly<{
  exampleId: string
  eventId: string
}>): FeedbackPolicyExample {
  return {
    runId: "run-1",
    subject: "solana:token",
    claimType: "token-upside",
    signals: {},
    originalVerdict: "track",
    targetVerdict: "track",
    polarity: "approval",
    split: "development",
    ...overrides,
  }
}

function dataset(examples: readonly FeedbackPolicyExample[]): SealedFeedbackDataset {
  return {
    schema: 1,
    datasetId: "fbds-test",
    sealedAt: "2026-08-10T00:00:00.000Z",
    ledgerHash: `sha256:${"a".repeat(64)}`,
    counts: {
      up: 5,
      completedDown: 3,
      preferencePairs: 0,
      policyExamples: examples.length,
    },
    preferencePairs: [],
    policyExamples: [...examples],
    tagCounts: { accuracy: 3 },
  }
}

describe("policy adjustment", () => {
  it("lowers the weight of a signal that separates corrections", () => {
    const adjustment = proposePolicyAdjustment({
      policy: BASELINE,
      examples: [
        example({
          exampleId: "ex-1",
          eventId: "ev-1",
          polarity: "correction",
          targetVerdict: "ignore",
          signals: { "market.momentum": 1 },
        }),
        example({
          exampleId: "ex-2",
          eventId: "ev-2",
          signals: { "market.momentum": 0 },
        }),
      ],
    })
    expect(adjustment.changedKeys).toEqual(["market.momentum"])
    expect(adjustment.weights["market.momentum"]).toBeLessThan(0)
  })

  it("changes nothing without a correction", () => {
    const adjustment = proposePolicyAdjustment({
      policy: BASELINE,
      examples: [example({
        exampleId: "ex-1",
        eventId: "ev-1",
        signals: { "market.momentum": 1 },
      })],
    })
    expect(adjustment.changedKeys).toEqual([])
  })

  it("ignores a signal key outside the known prefixes", () => {
    const adjustment = proposePolicyAdjustment({
      policy: BASELINE,
      examples: [
        example({
          exampleId: "ex-1",
          eventId: "ev-1",
          polarity: "correction",
          signals: { "invented.key": 1 },
        }),
        example({ exampleId: "ex-2", eventId: "ev-2", signals: { "invented.key": 0 } }),
      ],
    })
    expect(adjustment.changedKeys).toEqual([])
    expect(hasKnownSignalPrefix("invented.key")).toBe(false)
  })

  it("changes at most four keys", () => {
    const signals = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`market.k${i}`, i + 1]),
    )
    const adjustment = proposePolicyAdjustment({
      policy: BASELINE,
      examples: [
        example({
          exampleId: "ex-1",
          eventId: "ev-1",
          polarity: "correction",
          signals,
        }),
        example({
          exampleId: "ex-2",
          eventId: "ev-2",
          signals: Object.fromEntries(Object.keys(signals).map((k) => [k, 0])),
        }),
      ],
    })
    expect(adjustment.changedKeys.length).toBeLessThanOrEqual(MAX_CHANGED_RULES)
  })
})

describe("candidate confinement", () => {
  it("accepts a bounded change to the two allowed paths", () => {
    const result = checkCandidateConfinement({
      baseline: BASELINE,
      candidate: { ...BASELINE, weights: { "market.momentum": -0.05 } },
      changedPaths: [
        "agent/skills/decision-policy/policy.json",
        "config/broadcast-output-tuning.json",
      ],
    })
    expect(result.ok).toBe(true)
  })

  it("rejects any other path", () => {
    const result = checkCandidateConfinement({
      baseline: BASELINE,
      candidate: BASELINE,
      changedPaths: ["src/orchestrator/run.ts"],
    })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reasons[0]).toContain("path-not-allowed")
  })

  it("rejects a weight delta over the limit", () => {
    const result = checkCandidateConfinement({
      baseline: BASELINE,
      candidate: { ...BASELINE, weights: { "market.momentum": 0.5 } },
      changedPaths: ["agent/skills/decision-policy/policy.json"],
    })
    expect(!result.ok && result.reasons).toContain("weight-delta:market.momentum")
  })

  it("rejects a threshold delta over the limit", () => {
    const result = checkCandidateConfinement({
      baseline: BASELINE,
      candidate: { ...BASELINE, thresholds: { ...BASELINE.thresholds, track: 0.9 } },
      changedPaths: ["agent/skills/decision-policy/policy.json"],
    })
    expect(!result.ok && result.reasons).toContain("threshold-delta:track")
  })

  it("rejects a new rule", () => {
    const result = checkCandidateConfinement({
      baseline: BASELINE,
      candidate: {
        ...BASELINE,
        rules: [{ id: "r1", when: "market.momentum", then: "track" }],
      },
      changedPaths: ["agent/skills/decision-policy/policy.json"],
    })
    expect(!result.ok && result.reasons).toContain("rule-count-changed")
  })
})

describe("candidate evaluation", () => {
  const withPairs = (): SealedFeedbackDataset => ({
    ...dataset([
      example({
        exampleId: "ex-1",
        eventId: "ev-good",
        signals: { "market.momentum": 0 },
      }),
      example({
        exampleId: "ex-2",
        eventId: "ev-bad",
        polarity: "correction",
        signals: { "market.momentum": 1 },
      }),
    ]),
    preferencePairs: [{
      pairId: "pair-1",
      claimType: "token-upside",
      severity: "notable",
      preferredEventId: "ev-good",
      rejectedEventId: "ev-bad",
      rejectedTags: ["accuracy"],
    }],
  })

  it("fails without a market holdout replay", () => {
    const evaluation = evaluateFeedbackCandidate({
      dataset: withPairs(),
      baseline: BASELINE,
      candidate: { ...BASELINE, weights: { "market.momentum": -0.05 } },
    })
    expect(evaluation.pass).toBe(false)
    expect(evaluation.failReasons).toContain("market-holdout-missing")
  })

  it("fails when a protected market metric regresses", () => {
    const evaluation = evaluateFeedbackCandidate({
      dataset: withPairs(),
      baseline: { ...BASELINE, weights: { "market.momentum": 1 } },
      candidate: { ...BASELINE, weights: { "market.momentum": 0.75 } },
      replayMarketHoldout: () => ({
        ok: true,
        epochId: "epoch-1",
        protectedMetricsPass: false,
      }),
    })
    expect(evaluation.failReasons).toContain("protected-metrics")
  })

  it("records the consumed market holdout epoch", () => {
    const evaluation = evaluateFeedbackCandidate({
      dataset: withPairs(),
      baseline: { ...BASELINE, weights: { "market.momentum": 1 } },
      candidate: { ...BASELINE, weights: { "market.momentum": 0.75 } },
      replayMarketHoldout: () => ({
        ok: true,
        epochId: "epoch-1",
        protectedMetricsPass: true,
      }),
    })
    expect(evaluation.marketHoldoutEpochId).toBe("epoch-1")
  })

  it("splits preference pairs the same way every time", () => {
    const set: OperatorPreferenceSet = {
      schema: 1,
      datasetId: "fbds-test",
      sealedAt: "2026-08-10T00:00:00.000Z",
      pairs: Array.from({ length: 8 }, (_, i) => ({
        pairId: `pair-${i}`,
        claimType: "token-upside" as const,
        severity: "notable" as const,
        preferredSignals: {},
        rejectedSignals: {},
      })),
    }
    const first = splitPreferenceSet(set)
    const second = splitPreferenceSet(set)
    expect(first.holdout.pairs.map((p) => p.pairId))
      .toEqual(second.holdout.pairs.map((p) => p.pairId))
    expect(first.holdout.pairs).toHaveLength(2)
  })
})

describe("candidate apply", () => {
  let repoRoot: string
  let home: string

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "tc-fb-repo-"))
    home = mkdtempSync(join(tmpdir(), "tc-fb-home-"))
    execFileSync("git", ["init", "-q"], { cwd: repoRoot })
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot })
    execFileSync("git", ["config", "user.name", "test"], { cwd: repoRoot })
    const policyPath = join(repoRoot, "agent/skills/decision-policy/policy.json")
    mkdirSync(dirname(policyPath), { recursive: true })
    writeFileSync(policyPath, `${JSON.stringify(BASELINE, null, 2)}\n`)
    mkdirSync(join(repoRoot, "config"), { recursive: true })
    writeFileSync(
      join(repoRoot, "config/broadcast-output-tuning.json"),
      `${JSON.stringify({
        schema: 1,
        updatedAt: "2026-08-10T00:00:00.000Z",
        copyGuidance: [],
        worthinessGuidance: [],
      }, null, 2)}\n`,
    )
    execFileSync("git", ["add", "-A"], { cwd: repoRoot })
    execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: repoRoot })
  })

  function proposed() {
    return buildFeedbackCandidate({
      dataset: dataset([
        example({
          exampleId: "ex-1",
          eventId: "ev-1",
          polarity: "correction",
          signals: { "market.momentum": 1 },
        }),
        example({ exampleId: "ex-2", eventId: "ev-2", signals: { "market.momentum": 0 } }),
      ]),
      baseline: BASELINE,
      tuning: {
        schema: 1,
        updatedAt: "2026-08-10T00:00:00.000Z",
        copyGuidance: ["say the sector name, not the ticker"],
        worthinessGuidance: [],
      },
      nowIso: "2026-08-10T00:00:00.000Z",
      replayMarketHoldout: () => ({
        ok: true,
        epochId: "epoch-1",
        protectedMetricsPass: true,
      }),
    }).candidate
  }

  it("writes only the two allowlisted files", () => {
    const candidate = { ...proposed(), evaluation: { ...proposed().evaluation!, pass: true } }
    const written = applyFeedbackCandidate({
      repoRoot,
      candidate,
      layout: broadcastFeedbackLayout(home),
      nowIso: "2026-08-10T01:00:00.000Z",
    })
    expect(written.every((path) => (
      path === "agent/skills/decision-policy/policy.json"
      || path === "config/broadcast-output-tuning.json"
    ))).toBe(true)
    const tuning = JSON.parse(
      readFileSync(join(repoRoot, "config/broadcast-output-tuning.json"), "utf8"),
    ) as Record<string, unknown>
    expect(tuning["sourceCandidateId"]).toBe(candidate.candidateId)
  })

  it("refuses a dirty repository", () => {
    writeFileSync(join(repoRoot, "dirty.txt"), "x\n")
    const candidate = { ...proposed(), evaluation: { ...proposed().evaluation!, pass: true } }
    expect(() => applyFeedbackCandidate({
      repoRoot,
      candidate,
      layout: broadcastFeedbackLayout(home),
      nowIso: "2026-08-10T01:00:00.000Z",
    })).toThrow(FeedbackApplyError)
  })

  it("refuses a candidate that failed evaluation", () => {
    const candidate = proposed()
    expect(() => applyFeedbackCandidate({
      repoRoot,
      candidate: {
        ...candidate,
        evaluation: { ...candidate.evaluation!, pass: false, failReasons: ["x"] },
      },
      layout: broadcastFeedbackLayout(home),
      nowIso: "2026-08-10T01:00:00.000Z",
    })).toThrow(/evaluation/u)
  })

  it("marks a dismissed candidate without writing the repo", () => {
    const dismissed = dismissFeedbackCandidate({
      layout: broadcastFeedbackLayout(home),
      candidate: proposed(),
      nowIso: "2026-08-10T01:00:00.000Z",
    })
    expect(dismissed.status).toBe("dismissed")
  })
})
