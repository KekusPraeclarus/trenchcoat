import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  authorFromProvenance,
  curateSocialEvidence,
  looksPromotional,
  topicKeysFromItem,
} from "../../src/orchestrator/social-evidence.js"
import {
  assertNarrativeEvidenceQuality,
  assessNarrativeEvidenceQuality,
} from "../../src/orchestrator/narrative-evidence-gate.js"
import type { BroadcastItem, SnapshotEnvelope } from "../../src/contracts/schemas.js"

type SnapshotItem = SnapshotEnvelope["items"][number]

const FIXTURES = join(process.cwd(), "tests/fixtures/narrative-evidence")

const THRESHOLDS = {
  maxPromotionalShare: 0.5,
  minIndependentAuthors: 2,
  minFreshPosts: 2,
} as const

function loadFixture(name: string): SnapshotItem[] {
  const raw = JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as SnapshotEnvelope
  return [...raw.items]
}

function claim(type: BroadcastItem["auditClaim"]["type"]): BroadcastItem {
  return {
    severity: "notable",
    text: "test claim",
    refs: [],
    auditClaim: {
      type,
      subject: "base ai agents",
      direction: type === "token-downside" ? "down" : "up",
      horizonHours: 24,
      verificationRule: "narrative-heat",
    },
  }
}

describe("authorFromProvenance", () => {
  it("parses platform handles and ignores opaque provenance", () => {
    expect(authorFromProvenance("twitter:@Alpha_Caller")).toBe("twitter:alpha_caller")
    expect(authorFromProvenance("farcaster:@dwr")).toBe("farcaster:dwr")
    expect(authorFromProvenance("list-scan-2026:tweet:1")).toBeUndefined()
  })
})

describe("topicKeysFromItem", () => {
  it("keeps cashtags, hashtags, and long content words", () => {
    const keys = topicKeysFromItem({ text: "$BASE #AiAgents rotation into base and that" })
    expect(keys).toContain("base")
    expect(keys).toContain("aiagents")
    expect(keys).toContain("rotation")
    expect(keys).not.toContain("that")
  })
})

describe("looksPromotional", () => {
  it("flags sales phrases and ticker spam", () => {
    expect(looksPromotional("presale live, don't miss")).toBe(true)
    expect(looksPromotional("$AAA $BBB $CCC $DDD")).toBe(true)
    expect(looksPromotional("base sequencer fees fell again this week")).toBe(false)
  })
})

describe("curateSocialEvidence", () => {
  it("grades clean multi-author evidence as strong", () => {
    const assessment = curateSocialEvidence({ items: loadFixture("strong.json") })
    expect(assessment.counts.eligible).toBe(3)
    expect(assessment.authors).toHaveLength(3)
    expect(assessment.promotionalShare).toBe(0)
    const quality = assessNarrativeEvidenceQuality({
      assessment,
      thresholds: THRESHOLDS,
      enabled: true,
    })
    expect(quality.tier).toBe("strong")
    expect(quality.reasons).toEqual([])
  })

  it("drops status lines, duplicates, and promotion", () => {
    const assessment = curateSocialEvidence({ items: loadFixture("promotional.json") })
    expect(assessment.excludedCounts["collector-status"]).toBe(1)
    expect(assessment.excludedCounts.duplicate).toBe(1)
    expect(assessment.excludedCounts["promotion-pattern"]).toBe(1)
    expect(assessment.excludedCounts["repeated-promotion"]).toBe(1)
    expect(assessment.promotionalShare).toBeGreaterThan(0.5)
    const quality = assessNarrativeEvidenceQuality({
      assessment,
      thresholds: THRESHOLDS,
      enabled: true,
    })
    expect(quality.tier).toBe("limited")
    expect(quality.reasons).toContain("promotional-share-above-max")
  })

  it("keeps one author below the independence floor", () => {
    const assessment = curateSocialEvidence({ items: loadFixture("single-author.json") })
    expect(assessment.authors).toEqual(["twitter:solo_caller"])
    const quality = assessNarrativeEvidenceQuality({
      assessment,
      thresholds: THRESHOLDS,
      enabled: true,
    })
    expect(quality.tier).toBe("limited")
    expect(quality.reasons).toContain("authors-below-floor")
  })

  it("does not let a primary source bypass the author floor", () => {
    const assessment = curateSocialEvidence({
      items: loadFixture("single-author.json"),
      primarySourceHandles: ["solo_caller"],
    })
    expect(assessment.primarySourceAuthors).toEqual(["twitter:solo_caller"])
    const quality = assessNarrativeEvidenceQuality({
      assessment,
      thresholds: THRESHOLDS,
      enabled: true,
    })
    expect(quality.tier).toBe("limited")
  })

  it("reports tier none without eligible posts", () => {
    const assessment = curateSocialEvidence({ items: [] })
    const quality = assessNarrativeEvidenceQuality({
      assessment,
      thresholds: THRESHOLDS,
      enabled: true,
    })
    expect(quality.tier).toBe("none")
    expect(quality.reasons[0]).toBe("no-eligible-posts")
  })

  it("excludes expired posts", () => {
    const assessment = curateSocialEvidence({
      items: [{
        provenance: "twitter:@old_caller",
        text: "base ai agents were hot last month",
        ts: "2026-07-01T00:00:00.000Z",
        ageSec: 999_999,
        freshnessTier: "expired",
      }],
    })
    expect(assessment.excludedCounts.expired).toBe(1)
    expect(assessment.counts.eligible).toBe(0)
  })
})

describe("assertNarrativeEvidenceQuality", () => {
  const weak = assessNarrativeEvidenceQuality({
    assessment: curateSocialEvidence({ items: loadFixture("single-author.json") }),
    thresholds: THRESHOLDS,
    enabled: true,
  })
  const strong = assessNarrativeEvidenceQuality({
    assessment: curateSocialEvidence({ items: loadFixture("strong.json") }),
    thresholds: THRESHOLDS,
    enabled: true,
  })

  it("rejects narrative claims below strong", () => {
    const result = assertNarrativeEvidenceQuality({
      item: claim("narrative-emergence"),
      quality: weak,
    })
    expect(result).toEqual({
      ok: false,
      reason: "narrative-evidence-quality:authors-below-floor",
    })
  })

  it("passes token claims through the existing market gates", () => {
    expect(assertNarrativeEvidenceQuality({ item: claim("token-downside"), quality: weak }))
      .toEqual({ ok: true })
  })

  it("passes narrative claims on strong evidence", () => {
    expect(assertNarrativeEvidenceQuality({ item: claim("rotation"), quality: strong }))
      .toEqual({ ok: true })
  })

  it("passes everything when the gate is off or absent", () => {
    expect(assertNarrativeEvidenceQuality({ item: claim("rotation") })).toEqual({ ok: true })
    expect(assertNarrativeEvidenceQuality({
      item: claim("rotation"),
      quality: { ...weak, enabled: false },
    })).toEqual({ ok: true })
  })
})
