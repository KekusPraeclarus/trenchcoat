import { describe, expect, it } from "vitest"
import {
  freshnessFromIso,
  freshnessTierForAge,
  isLiveEligible,
  LIVE_SEC,
  snapshotFieldsFromEvent,
  STALE_VISIBLE_SEC,
} from "../../src/collectors/pump/freshness.js"

describe("pump freshness helpers", () => {
  it("tiers age into live/stale/expired", () => {
    expect(freshnessTierForAge(0)).toBe("live")
    expect(freshnessTierForAge(LIVE_SEC)).toBe("live")
    expect(freshnessTierForAge(LIVE_SEC + 1)).toBe("stale")
    expect(freshnessTierForAge(STALE_VISIBLE_SEC + 1)).toBe("expired")
  })

  it("rejects missing and future timestamps", () => {
    expect(freshnessFromIso(undefined, "2026-08-13T00:00:00.000Z").ok).toBe(false)
    expect(freshnessFromIso("2026-08-14T00:00:00.000Z", "2026-08-13T00:00:00.000Z").reason)
      .toBe("future-timestamp")
  })

  it("accepts only live events for feed snapshots", () => {
    const fetchedAt = "2026-08-13T12:00:00.000Z"
    const live = snapshotFieldsFromEvent("2026-08-13T11:00:00.000Z", fetchedAt)
    expect(live.accepted).toBe(true)
    expect(isLiveEligible(live.ageSec)).toBe(true)
    const old = snapshotFieldsFromEvent("2026-08-12T11:00:00.000Z", fetchedAt)
    expect(old.accepted).toBe(false)
  })
})
