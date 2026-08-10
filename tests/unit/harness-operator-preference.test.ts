import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  activePreferenceSetPath,
  checkPreferenceRegression,
  loadActivePreferenceSet,
  preferenceAgreement,
} from "../../src/harness/operator-preference.js"
import {
  buildOperatorPreferenceSet,
  signalsFromExamples,
  writeActivePreferenceSet,
} from "../../src/broadcast-feedback/policy-preferences.js"
import { broadcastFeedbackLayout } from "../../src/broadcast-feedback/paths.js"
import type {
  DecisionPolicyDocument,
  OperatorPreferenceSet,
  SealedFeedbackDataset,
} from "../../src/contracts/schemas.js"

const POLICY: DecisionPolicyDocument = {
  schema: 1,
  policyVersion: "baseline",
  kind: "baseline",
  createdAt: "2026-07-19T00:00:00.000Z",
  weights: { "market.momentum": 1 },
  thresholds: { track: 0.5, ignore: 0, drop: -0.5 },
  rules: [],
  allowlistPaths: ["agent/skills/decision-policy/policy.json"],
}

const SET: OperatorPreferenceSet = {
  schema: 1,
  datasetId: "fbds-1",
  sealedAt: "2026-08-10T00:00:00.000Z",
  pairs: [{
    pairId: "pair-1",
    claimType: "token-upside",
    severity: "notable",
    preferredSignals: { "market.momentum": 0 },
    rejectedSignals: { "market.momentum": 1 },
  }],
}

describe("preference agreement", () => {
  it("counts a pair the policy respects", () => {
    const respectful = { ...POLICY, weights: { "market.momentum": -1 } }
    const agreement = preferenceAgreement({ policy: respectful, set: SET })
    expect(agreement.pairs).toBe(1)
    expect(agreement.agreed).toBe(1)
    expect(agreement.agreement).toBe(1)
  })

  it("counts a pair the policy contradicts", () => {
    expect(preferenceAgreement({ policy: POLICY, set: SET }).agreement).toBe(0)
  })

  it("treats an empty set as full agreement", () => {
    expect(preferenceAgreement({
      policy: POLICY,
      set: { ...SET, pairs: [] },
    }).agreement).toBe(1)
  })
})

describe("preference regression gate", () => {
  it("passes when agreement rises", () => {
    const better = { ...POLICY, weights: { "market.momentum": -1 } }
    const check = checkPreferenceRegression({
      baselinePolicy: POLICY,
      candidatePolicy: better,
      set: SET,
    })
    expect(check.ok).toBe(true)
    expect(check.candidate).toBeGreaterThan(check.baseline)
  })

  it("fails when agreement falls", () => {
    const baseline = { ...POLICY, weights: { "market.momentum": -1 } }
    const check = checkPreferenceRegression({
      baselinePolicy: baseline,
      candidatePolicy: POLICY,
      set: SET,
    })
    expect(check.ok).toBe(false)
    expect(check.reason).toBe("operator-preference-regression")
  })

  it("never blocks when no sealed set exists", () => {
    expect(checkPreferenceRegression({
      baselinePolicy: POLICY,
      candidatePolicy: POLICY,
    }).ok).toBe(true)
  })
})

describe("active preference set file", () => {
  it("returns undefined when the file is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "tc-pref-none-"))
    expect(loadActivePreferenceSet(join(root, "missing.json"))).toBeUndefined()
  })

  it("returns undefined when the file is unreadable", () => {
    const root = mkdtempSync(join(tmpdir(), "tc-pref-bad-"))
    const path = join(root, "active-preference-set.json")
    writeFileSync(path, "{ not json")
    expect(loadActivePreferenceSet(path)).toBeUndefined()
  })

  it("reads a set the feedback lane wrote", () => {
    const home = mkdtempSync(join(tmpdir(), "tc-pref-home-"))
    const dataset: SealedFeedbackDataset = {
      schema: 1,
      datasetId: "fbds-2",
      sealedAt: "2026-08-10T00:00:00.000Z",
      ledgerHash: `sha256:${"b".repeat(64)}`,
      counts: { up: 3, completedDown: 3, preferencePairs: 1, policyExamples: 2 },
      preferencePairs: [{
        pairId: "pair-1",
        claimType: "token-upside",
        severity: "notable",
        preferredEventId: "ev-good",
        rejectedEventId: "ev-bad",
        rejectedTags: ["accuracy"],
      }],
      policyExamples: [
        {
          exampleId: "ex-1",
          eventId: "ev-good",
          runId: "run-1",
          subject: "solana:a",
          claimType: "token-upside",
          signals: { "market.momentum": 0 },
          originalVerdict: "track",
          targetVerdict: "track",
          polarity: "approval",
          split: "development",
        },
        {
          exampleId: "ex-2",
          eventId: "ev-bad",
          runId: "run-1",
          subject: "solana:b",
          claimType: "token-upside",
          signals: { "market.momentum": 1 },
          originalVerdict: "track",
          targetVerdict: "ignore",
          polarity: "correction",
          split: "development",
        },
      ],
      tagCounts: { accuracy: 1 },
    }
    const layout = broadcastFeedbackLayout(home)
    mkdirSync(layout.sealed, { recursive: true })
    const set = buildOperatorPreferenceSet({
      dataset,
      signalsByEvent: signalsFromExamples(dataset.policyExamples),
    })
    writeActivePreferenceSet({ layout, set })
    const loaded = loadActivePreferenceSet(activePreferenceSetPath(home))
    expect(loaded?.datasetId).toBe("fbds-2")
    expect(loaded?.pairs[0]?.rejectedSignals).toEqual({ "market.momentum": 1 })
  })

  it("keeps operator prose out of the sealed set", () => {
    const set = buildOperatorPreferenceSet({
      signalsByEvent: new Map([
        ["ev-good", { "market.momentum": 0 }],
        ["ev-bad", { "market.momentum": 1 }],
      ]),
      dataset: {
        schema: 1,
        datasetId: "fbds-3",
        sealedAt: "2026-08-10T00:00:00.000Z",
        ledgerHash: `sha256:${"c".repeat(64)}`,
        counts: { up: 1, completedDown: 1, preferencePairs: 1, policyExamples: 0 },
        preferencePairs: [{
          pairId: "pair-1",
          claimType: "token-upside",
          severity: "notable",
          preferredEventId: "ev-good",
          rejectedEventId: "ev-bad",
          rejectedTags: ["accuracy"],
        }],
        policyExamples: [],
        tagCounts: {},
      },
    })
    expect(JSON.stringify(set)).not.toContain("ev-good")
  })
})
