import { describe, expect, it } from "vitest"
import {
  buildPolicyExamples,
  buildPreferencePairs,
  checkSealFloors,
  saferVerdict,
  splitExamples,
} from "../../src/broadcast-feedback/aggregate.js"
import type { BroadcastFeedbackRecord } from "../../src/broadcast-feedback/schemas.js"
import type { SealedFeedbackDataset } from "../../src/contracts/schemas.js"

function record(overrides: Partial<BroadcastFeedbackRecord> & Readonly<{
  feedbackId: string
  eventId: string
}>): BroadcastFeedbackRecord {
  return {
    schema: 1,
    deliveryId: "del-1",
    runId: "run-1",
    providerMessageId: "100000000000000001",
    partIndex: 0,
    partTotal: 1,
    operatorUserId: "200000000000000002",
    state: "up",
    firstReactionAt: "2026-08-10T00:00:00.000Z",
    lastReactionAt: "2026-08-10T00:00:00.000Z",
    followupStatus: "not-required",
    tags: [],
    severity: "notable",
    auditClaim: {
      type: "token-upside",
      subject: "solana:token",
      direction: "up",
      horizonHours: 72,
      verificationRule: "token.up.72h",
    },
    ...overrides,
  }
}

describe("preference pairs", () => {
  it("pairs one liked and one disliked broadcast of the same shape", () => {
    const pairs = buildPreferencePairs([
      record({ feedbackId: "fb-1", eventId: "ev-1", state: "up" }),
      record({
        feedbackId: "fb-2",
        eventId: "ev-2",
        state: "down",
        followupStatus: "completed",
        tags: ["too-long"],
      }),
    ])
    expect(pairs).toHaveLength(1)
    expect(pairs[0]?.preferredEventId).toBe("ev-1")
    expect(pairs[0]?.rejectedEventId).toBe("ev-2")
    expect(pairs[0]?.rejectedTags).toEqual(["too-long"])
  })

  it("never pairs across claim type or severity", () => {
    const pairs = buildPreferencePairs([
      record({ feedbackId: "fb-1", eventId: "ev-1", state: "up", severity: "watch" }),
      record({
        feedbackId: "fb-2",
        eventId: "ev-2",
        state: "down",
        followupStatus: "completed",
        tags: ["tone"],
        severity: "urgent",
      }),
    ])
    expect(pairs).toHaveLength(0)
  })

  it("ignores a down reaction with no completed detail", () => {
    const pairs = buildPreferencePairs([
      record({ feedbackId: "fb-1", eventId: "ev-1", state: "up" }),
      record({ feedbackId: "fb-2", eventId: "ev-2", state: "down" }),
    ])
    expect(pairs).toHaveLength(0)
  })
})

describe("policy examples", () => {
  const signals = () => ({ "market.momentum": 1 })
  const verdicts = () => "track" as const

  it("keeps an approval at the original verdict", () => {
    const examples = buildPolicyExamples({
      records: [record({ feedbackId: "fb-1", eventId: "ev-1", state: "up" })],
      signals,
      verdicts,
    })
    expect(examples).toHaveLength(1)
    expect(examples[0]?.polarity).toBe("approval")
    expect(examples[0]?.targetVerdict).toBe("track")
  })

  it("maps an accuracy correction to a safer verdict", () => {
    const examples = buildPolicyExamples({
      records: [record({
        feedbackId: "fb-1",
        eventId: "ev-1",
        state: "down",
        followupStatus: "completed",
        tags: ["accuracy"],
      })],
      signals,
      verdicts,
    })
    expect(examples[0]?.polarity).toBe("correction")
    expect(examples[0]?.targetVerdict).toBe("ignore")
  })

  it("keeps narrative feedback out of decision policy", () => {
    const examples = buildPolicyExamples({
      records: [record({
        feedbackId: "fb-1",
        eventId: "ev-1",
        state: "up",
        auditClaim: {
          type: "narrative-emergence",
          subject: "base ai agents",
          direction: "up",
          horizonHours: 72,
          verificationRule: "narrative.emergence",
        },
      })],
      signals,
      verdicts,
    })
    expect(examples).toHaveLength(0)
  })

  it("skips a broadcast with no archived decision signals", () => {
    const examples = buildPolicyExamples({
      records: [record({ feedbackId: "fb-1", eventId: "ev-1", state: "up" })],
      signals: () => undefined,
      verdicts,
    })
    expect(examples).toHaveLength(0)
  })

  it("drops a tone-only complaint from decision policy", () => {
    const examples = buildPolicyExamples({
      records: [record({
        feedbackId: "fb-1",
        eventId: "ev-1",
        state: "down",
        followupStatus: "completed",
        tags: ["tone"],
      })],
      signals,
      verdicts,
    })
    expect(examples).toHaveLength(0)
  })

  it("maps drop to revisit as the safer verdict", () => {
    expect(saferVerdict("drop")).toBe("revisit")
    expect(saferVerdict("track")).toBe("ignore")
    expect(saferVerdict("ignore")).toBe("ignore")
  })

  it("splits deterministically into development and holdout", () => {
    const base = buildPolicyExamples({
      records: Array.from({ length: 8 }, (_, i) => record({
        feedbackId: `fb-${i}`,
        eventId: `ev-${i}`,
        state: "up",
      })),
      signals,
      verdicts,
    })
    const again = splitExamples(base)
    expect(again.map((e) => e.split)).toEqual(base.map((e) => e.split))
    expect(base.filter((e) => e.split === "holdout").length).toBe(2)
  })
})

describe("seal floors", () => {
  const dataset = (counts: Partial<SealedFeedbackDataset["counts"]>, examples = 0) => ({
    schema: 1,
    datasetId: "fbds-1",
    sealedAt: "2026-08-10T00:00:00.000Z",
    ledgerHash: `sha256:${"a".repeat(64)}`,
    counts: {
      up: 5,
      completedDown: 3,
      preferencePairs: 2,
      policyExamples: 5,
      ...counts,
    },
    preferencePairs: [],
    policyExamples: Array.from({ length: examples }, (_, i) => ({
      exampleId: `ex-${i}`,
      eventId: `ev-${i}`,
      runId: "run-1",
      subject: "solana:token",
      claimType: "token-upside" as const,
      signals: {},
      originalVerdict: "track" as const,
      targetVerdict: "track" as const,
      polarity: "approval" as const,
      split: (i % 4 === 3 ? "holdout" : "development") as "holdout" | "development",
    })),
    tagCounts: {},
  }) as SealedFeedbackDataset

  const floors = {
    minPolicyExamples: 5,
    minCompletedDown: 3,
    minPreferencePairs: 2,
  }

  it("passes when every floor is met", () => {
    expect(checkSealFloors({ dataset: dataset({}, 8), floors })).toEqual([])
  })

  it("names each missing floor", () => {
    const misses = checkSealFloors({
      dataset: dataset({ policyExamples: 1, completedDown: 0, preferencePairs: 0 }, 1),
      floors,
    })
    expect(misses).toContain("policy-examples")
    expect(misses).toContain("completed-down")
    expect(misses).toContain("preference-pairs")
    expect(misses).toContain("development-examples")
    expect(misses).toContain("holdout-examples")
  })
})
