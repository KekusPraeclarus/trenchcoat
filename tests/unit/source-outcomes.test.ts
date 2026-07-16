import { describe, expect, it } from "vitest"
import { aggregateSourcePerformance } from "../../src/sources/outcomes.js"

describe("source outcomes", () => {
  it("excludes same-window settlement and dedupes copied calls", () => {
    const cutoff = "2026-07-10T00:00:00.000Z"
    const base = {
      eventId: "call-1",
      sourceId: "x_alice",
      tokenId: "sol_token",
      mentionedAt: "2026-07-01T00:00:00.000Z",
      settledAt: "2026-07-04T00:00:00.000Z",
      excessReturn72h: 0.30,
      rug: false,
    }
    const performance = aggregateSourcePerformance(
      "x_alice",
      [
        base,
        base,
        {
          ...base,
          eventId: "call-2",
          settledAt: "2026-07-11T00:00:00.000Z",
        },
        {
          ...base,
          eventId: "call-after-cutoff",
          mentionedAt: cutoff,
        },
      ],
      cutoff,
    )

    expect(performance.eligibleCalls).toBe(2)
    expect(performance.settledCalls).toBe(1)
    expect(performance.hits).toBe(1)
    expect(performance.coverage).toBe(0.5)
  })
})
