import { describe, expect, it } from "vitest"

import {
  freezeAuditEpoch,
  isAuditSubjectEligible,
  type AuditEpochInput,
  type AuditSubject,
} from "../src/orchestrator/audit.js"

const CONFIG_HASH = `sha256:${"a".repeat(64)}` as const

const subject: AuditSubject = {
  id: "decision-1",
  type: "decision",
  eventTimestamp: 1_000,
  horizonHours: 24,
}

function input(subjects: readonly AuditSubject[]): AuditEpochInput {
  return {
    epochId: "audit-2026-W29",
    previousEpochId: "audit-2026-W28",
    startedAt: 200_000,
    cutoffTimestamp: 109_000,
    settlementDelayHours: 6,
    priorSourceScoreCutoff: 90_000,
    configHash: CONFIG_HASH,
    featureSpecVersion: 1,
    executionModelVersion: 1,
    codeCommit: "abcdef1",
    subjects,
  }
}

describe("audit epochs", () => {
  it("uses event time plus horizon and settlement delay inclusively", () => {
    expect(isAuditSubjectEligible(subject, 109_000, 6)).toBe(true)
    expect(isAuditSubjectEligible(subject, 108_999, 6)).toBe(false)
  })

  it("has a stable manifest hash regardless of input ordering", () => {
    const another: AuditSubject = {
      id: "source-call-1",
      type: "source-call",
      eventTimestamp: 500,
      horizonHours: 24,
    }

    const left = freezeAuditEpoch(input([subject, another]))
    const right = freezeAuditEpoch(input([another, subject]))

    expect(left.manifestHash).toBe(right.manifestHash)
    expect(left.subjects.map((entry) => entry.type)).toEqual([
      "decision",
      "source-call",
    ])
    expect(Object.isFrozen(left)).toBe(true)
    expect(Object.isFrozen(left.subjects)).toBe(true)
  })

  it("rejects duplicate and immature subjects", () => {
    expect(() => freezeAuditEpoch(input([subject, subject]))).toThrow(/Duplicate/u)

    const immature = { ...subject, id: "decision-2", eventTimestamp: 1_001 }
    expect(() => freezeAuditEpoch(input([immature]))).toThrow(/Ineligible/u)
  })

  it("rejects malformed hashes and time-travelled epoch starts", () => {
    expect(() => freezeAuditEpoch({
      ...input([subject]),
      configHash: "sha256:bad",
    } as AuditEpochInput)).toThrow(/config hash/u)

    expect(() => freezeAuditEpoch({
      ...input([subject]),
      startedAt: 100_000,
    })).toThrow(/start before/u)
  })
})
