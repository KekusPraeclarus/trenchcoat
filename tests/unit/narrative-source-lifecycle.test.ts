import { describe, expect, it } from "vitest"
import {
  backfillNarrativeProbation,
  creditNarrativeContribution,
  emptyNarrativeSources,
  markFollowed,
  registerNarrativeProbation,
  reviewNarrativeSources,
} from "../../src/sources/narrative-lifecycle.js"

describe("narrative source lifecycle", () => {
  it("backfills classified handles from now so review does not demote on day one", () => {
    const file = backfillNarrativeProbation(
      emptyNarrativeSources(),
      ["Alpha", "beta", "alpha"],
      "2026-09-04T16:00:00.000Z",
      14,
    )
    expect(file.sources).toHaveLength(2)
    expect(file.sources[0]?.handle).toBe("alpha")
    expect(file.sources[0]?.addedAt).toBe("2026-09-04T16:00:00.000Z")
    expect(file.sources[0]?.probationEndsAt).toBe("2026-09-18T16:00:00.000Z")
    const reviewed = reviewNarrativeSources(file, {
      nowIso: "2026-09-04T16:00:00.000Z",
      minAccepted: 3,
      minDistinct: 2,
      demotionIdleDays: 28,
    })
    expect(reviewed.sources.every((item) => item.status === "probation")).toBe(true)
  })

  it("registers probation once and credits distinct narratives by slug", () => {
    let file = registerNarrativeProbation(
      emptyNarrativeSources(),
      "Alpha",
      "2026-07-01T00:00:00.000Z",
      14,
    )
    file = registerNarrativeProbation(file, "alpha", "2026-07-02T00:00:00.000Z", 14)
    expect(file.sources).toHaveLength(1)

    file = creditNarrativeContribution(file, {
      handle: "alpha",
      narrativeSlug: "ai-agents",
      at: "2026-07-02T12:00:00.000Z",
    })
    file = creditNarrativeContribution(file, {
      handle: "alpha",
      narrativeSlug: "ai-agents",
      at: "2026-07-03T12:00:00.000Z",
    })
    file = creditNarrativeContribution(file, {
      handle: "alpha",
      narrativeSlug: "sol-memes",
      at: "2026-07-04T12:00:00.000Z",
    })
    const src = file.sources[0]!
    expect(src.acceptedContributions).toBe(3)
    expect(src.distinctNarratives).toBe(2)
    expect(src.acceptedNarrativeSlugs).toEqual(["ai-agents", "sol-memes"])
    expect(src.contributionDays).toEqual([
      "2026-07-02",
      "2026-07-03",
      "2026-07-04",
    ])
  })

  it("promotes after probation when utility thresholds pass", () => {
    let file = registerNarrativeProbation(
      emptyNarrativeSources(),
      "n1",
      "2026-07-01T00:00:00.000Z",
      14,
    )
    for (const [i, slug] of ["a", "b", "a"].entries()) {
      file = creditNarrativeContribution(file, {
        handle: "n1",
        narrativeSlug: slug,
        at: `2026-07-0${i + 2}T00:00:00.000Z`,
      })
    }
    file = reviewNarrativeSources(file, {
      nowIso: "2026-07-16T00:00:00.000Z",
      minAccepted: 3,
      minDistinct: 2,
      demotionIdleDays: 28,
    })
    expect(file.sources[0]?.status).toBe("follow-eligible")
    file = markFollowed(file, "n1", "2026-07-16T01:00:00.000Z")
    expect(file.sources[0]?.status).toBe("followed")
  })

  it("hard-docks and idle-demotes independently of managed-list state", () => {
    let file = registerNarrativeProbation(
      emptyNarrativeSources(),
      "dock",
      "2026-06-01T00:00:00.000Z",
      14,
    )
    file = {
      schema: 1,
      sources: [{
        ...file.sources[0]!,
        status: "followed",
        hardDocked: true,
        lastContributionAt: "2026-06-02T00:00:00.000Z",
      }],
    }
    file = reviewNarrativeSources(file, {
      nowIso: "2026-07-16T00:00:00.000Z",
      minAccepted: 3,
      minDistinct: 2,
      demotionIdleDays: 28,
    })
    expect(file.sources[0]?.status).toBe("demoted")
  })
})
