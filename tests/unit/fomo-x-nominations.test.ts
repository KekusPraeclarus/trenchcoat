import { describe, expect, it } from "vitest"
import {
  applyClassificationResult,
  classifiedNarrativeXHandles,
  emptyXSourceNominations,
  markClassifying,
  nextPendingNomination,
  nominationIdForHandle,
  resolveXHandleFromTrader,
  upsertXSourceNominations,
} from "../../src/sources/x-nominations.js"
import type { FomoLeaderboardEntry } from "../../src/collectors/fomo/types.js"

function trader(partial: Partial<FomoLeaderboardEntry> & Pick<FomoLeaderboardEntry, "handle">): FomoLeaderboardEntry {
  return {
    handle: partial.handle,
    timeframe: partial.timeframe ?? "7d",
    rank: partial.rank ?? 1,
    wallets: partial.wallets ?? [],
    observedAt: partial.observedAt ?? "2026-07-19T00:00:00.000Z",
    ...(partial.xHandle ? { xHandle: partial.xHandle } : {}),
  }
}

describe("x-source nominations", () => {
  it("prefers explicit Fomo profile X link over same-handle", () => {
    const resolved = resolveXHandleFromTrader(trader({
      handle: "alpha",
      xHandle: "https://x.com/RealAlpha",
    }))
    expect(resolved).toEqual({ xHandle: "realalpha", matchBasis: "fomo-profile-link" })
  })

  it("falls back to same-handle when no explicit X link", () => {
    expect(resolveXHandleFromTrader(trader({ handle: "SameHandle" }))).toEqual({
      xHandle: "samehandle",
      matchBasis: "same-handle",
    })
  })

  it("skips same-handle when requireProfileLink is set", () => {
    const file = upsertXSourceNominations(emptyXSourceNominations(), {
      traders: [
        trader({ handle: "sameonly" }),
        trader({ handle: "linked", xHandle: "https://x.com/LinkedX" }),
      ],
      nominatedAt: "2026-07-19T00:00:00.000Z",
      maxPending: 10,
      requireProfileLink: true,
    })
    expect(file.nominations).toHaveLength(1)
    expect(file.nominations[0]?.xHandle).toBe("linkedx")
    expect(file.nominations[0]?.matchBasis).toBe("fomo-profile-link")
  })

  it("dedupes by nominationId and bounds pending queue", () => {
    const traders = Array.from({ length: 5 }, (_, i) => trader({
      handle: `h${i}`,
      rank: i + 1,
    }))
    const file = upsertXSourceNominations(emptyXSourceNominations(), {
      traders,
      nominatedAt: "2026-07-19T00:00:00.000Z",
      maxPending: 2,
    })
    expect(file.nominations.filter((n) => n.status === "pending")).toHaveLength(2)
    expect(nominationIdForHandle("h0")).toHaveLength(24)
  })

  it("expires stale pending nominations and advances classifying → classified", () => {
    let file = upsertXSourceNominations(emptyXSourceNominations(), {
      traders: [trader({ handle: "fresh" })],
      nominatedAt: "2026-07-01T00:00:00.000Z",
      maxPending: 10,
    })
    file = upsertXSourceNominations(file, {
      traders: [trader({ handle: "fresh" })],
      nominatedAt: "2026-07-10T00:00:00.000Z",
      maxPending: 10,
    })
    const pending = nextPendingNomination(file, "2026-07-10T01:00:00.000Z")
    expect(pending?.xHandle).toBe("fresh")
    file = markClassifying(file, pending!.nominationId)
    file = applyClassificationResult(file, {
      nominationId: pending!.nominationId,
      status: "classified",
      classification: "shiller",
      classificationRunId: "run-1",
    })
    expect(file.nominations[0]?.status).toBe("classified")
    expect(file.nominations[0]?.classification).toBe("shiller")
  })

  it("selects classified narrative and both handles with a profile X link", () => {
    const handles = classifiedNarrativeXHandles({
      schema: 1,
      nominations: [
        {
          nominationId: "a",
          fomoHandle: "n1",
          xHandle: "NarrativeOne",
          matchBasis: "fomo-profile-link",
          nominatedAt: "2026-08-01T00:00:00.000Z",
          expiresAt: "2026-08-15T00:00:00.000Z",
          status: "classified",
          attempts: 1,
          classification: "narrative",
        },
        {
          nominationId: "b",
          fomoHandle: "b1",
          xHandle: "BothOne",
          matchBasis: "fomo-profile-link",
          nominatedAt: "2026-08-01T00:00:00.000Z",
          expiresAt: "2026-08-15T00:00:00.000Z",
          status: "classified",
          attempts: 1,
          classification: "both",
        },
        {
          nominationId: "c",
          fomoHandle: "s1",
          xHandle: "ShillerOne",
          matchBasis: "fomo-profile-link",
          nominatedAt: "2026-08-01T00:00:00.000Z",
          expiresAt: "2026-08-15T00:00:00.000Z",
          status: "classified",
          attempts: 1,
          classification: "shiller",
        },
        {
          nominationId: "d",
          fomoHandle: "same",
          xHandle: "SameNarr",
          matchBasis: "same-handle",
          nominatedAt: "2026-08-01T00:00:00.000Z",
          expiresAt: "2026-08-15T00:00:00.000Z",
          status: "classified",
          attempts: 1,
          classification: "narrative",
        },
        {
          nominationId: "e",
          fomoHandle: "pend",
          xHandle: "PendingNarr",
          matchBasis: "fomo-profile-link",
          nominatedAt: "2026-08-01T00:00:00.000Z",
          expiresAt: "2026-08-15T00:00:00.000Z",
          status: "pending",
          attempts: 0,
        },
      ],
    })
    expect(handles).toEqual(["narrativeone", "bothone"])
  })
})
