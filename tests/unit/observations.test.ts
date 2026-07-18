import { describe, expect, it } from "vitest"
import { materializeObservation, type PriceBar } from "../../src/orchestrator/observations.js"

const EVENT = "2026-07-01T00:00:00.000Z"
const OBSERVED = "2026-07-10T00:00:00.000Z"

function bar(ts: string, open: number, finalized = true): PriceBar {
  return { ts, open, finalized }
}

describe("materializeObservation", () => {
  it("picks the first eligible finalized open strictly after the event as P0", () => {
    const obs = materializeObservation({
      subjectType: "source-call",
      subjectId: "src:tok",
      eventTs: EVENT,
      horizonHours: 24,
      observedAt: OBSERVED,
      bars: [
        bar("2026-07-01T00:00:00.000Z", 5),   // at eventTs, excluded (strictly after)
        bar("2026-07-01T00:05:00.000Z", 10),  // P0
        bar("2026-07-01T00:10:00.000Z", 11),
        bar("2026-07-02T00:05:00.000Z", 20),  // Ph (>= +24h)
      ],
    })
    expect(obs.status).toBe("complete")
    expect(obs.targetPrice).toBe(20)
    expect(obs.rawReturn).toBeCloseTo(1) // 20/10 - 1
    expect(obs.excessReturn).toBeCloseTo(1)
  })

  it("skips unfinalized bars for P0/Ph and applies benchmark and fees", () => {
    const obs = materializeObservation({
      subjectType: "wallet-buy",
      subjectId: "wb_x",
      eventTs: EVENT,
      horizonHours: 24,
      observedAt: OBSERVED,
      benchmarkReturn: 0.1,
      feeBpsPerSide: 50,
      bars: [
        bar("2026-07-01T00:05:00.000Z", 10, false), // unfinalized, not P0
        bar("2026-07-01T00:10:00.000Z", 10),        // P0
        bar("2026-07-02T00:05:00.000Z", 12),        // Ph
      ],
    })
    expect(obs.status).toBe("complete")
    const raw = 12 / 10 - 1
    const costAdjusted = raw - (50 * 2) / 10_000
    expect(obs.rawReturn).toBeCloseTo(raw)
    expect(obs.benchmarkReturn).toBe(0.1)
    expect(obs.excessReturn).toBeCloseTo(costAdjusted - 0.1)
  })

  it("returns provider-pending, never a loss, when the horizon leg is only unfinalized", () => {
    const obs = materializeObservation({
      subjectType: "source-call",
      subjectId: "src:tok",
      eventTs: EVENT,
      horizonHours: 24,
      observedAt: OBSERVED,
      bars: [
        bar("2026-07-01T00:05:00.000Z", 10),        // P0 present
        bar("2026-07-02T00:05:00.000Z", 20, false), // Ph unfinalized
      ],
    })
    expect(obs.status).toBe("provider-pending")
    expect(obs.excessReturn).toBeUndefined()
    expect(obs.rawReturn).toBeUndefined()
    expect(obs.status).not.toBe("terminal-loss")
    expect(obs.exclusionReason).toContain("ph")
  })

  it("returns censored, never a loss, when no eligible bars exist at all", () => {
    const obs = materializeObservation({
      subjectType: "wallet-buy",
      subjectId: "wb_empty",
      eventTs: EVENT,
      horizonHours: 72,
      observedAt: OBSERVED,
      bars: [],
    })
    expect(obs.status).toBe("censored")
    expect(obs.excessReturn).toBeUndefined()
    expect(obs.status).not.toBe("terminal-loss")
  })
})
