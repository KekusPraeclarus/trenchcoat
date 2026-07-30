import { describe, expect, it } from "vitest"
import {
  deriveWatchWindow,
  scrubLeakedHourHorizons,
  scrubWatchProse,
  scrubWeeklyTimeframes,
  watchWindowForHours,
} from "../../src/lib/watch-window.js"

describe("deriveWatchWindow", () => {
  it("keeps token claims close to the hour bucket", () => {
    expect(deriveWatchWindow({ type: "token-upside", horizonHours: 24 }))
      .toBe("the next day")
    expect(deriveWatchWindow({ type: "token-upside", horizonHours: 72 }))
      .toBe("the next few days")
    expect(deriveWatchWindow({ type: "token-upside", horizonHours: 168 }))
      .toBe("this month")
  })

  it("uses the conditional window for week-scale buckets", () => {
    expect(deriveWatchWindow({ type: "token-upside", horizonHours: 96 }))
      .toBe("if it holds")
    expect(deriveWatchWindow({ type: "rotation", horizonHours: 72 }))
      .toBe("if it holds")
  })

  it("bumps narrative/rotation one communicative bucket longer", () => {
    expect(deriveWatchWindow({ type: "narrative-emergence", horizonHours: 168 }))
      .toBe("through next month")
    expect(deriveWatchWindow({ type: "narrative-fade", horizonHours: 96 }))
      .toBe("this month")
  })

  it("never derives a weekly timeframe", () => {
    const windows = [
      deriveWatchWindow({ type: "token-upside", horizonHours: 24 }),
      deriveWatchWindow({ type: "token-upside", horizonHours: 96 }),
      deriveWatchWindow({ type: "token-upside", horizonHours: 168 }),
      deriveWatchWindow({ type: "rotation", horizonHours: 72 }),
      deriveWatchWindow({ type: "narrative-emergence", horizonHours: 168 }),
    ]
    for (const window of windows) {
      expect(window).not.toMatch(/week/u)
    }
  })
})

describe("scrubLeakedHourHorizons", () => {
  it("scrubs leaked hour tokens and wrappers", () => {
    expect(scrubLeakedHourHorizons("over the next 72h")).toBe("the next few days")
    expect(scrubLeakedHourHorizons("in 72 hr")).toBe("in the next few days")
    expect(scrubLeakedHourHorizons("watch 72h")).toBe("watch the next few days")
    expect(scrubLeakedHourHorizons("over the next 24h")).toBe("the next day")
    expect(scrubLeakedHourHorizons("in the next 168 hours")).toBe("this month")
  })

  it("leaves natural watch prose alone", () => {
    expect(scrubLeakedHourHorizons("watch this week")).toBe("watch this week")
    expect(scrubLeakedHourHorizons("through next month")).toBe("through next month")
    expect(scrubLeakedHourHorizons("the coming weeks")).toBe("the coming weeks")
  })
})

describe("scrubWeeklyTimeframes", () => {
  it("rewrites weekly timeframes to the conditional", () => {
    expect(scrubWeeklyTimeframes("worth watching over the coming week"))
      .toBe("worth watching if it holds")
    expect(scrubWeeklyTimeframes("worth watching into the coming weeks"))
      .toBe("worth watching if it holds")
    expect(scrubWeeklyTimeframes("leaders still firm this week"))
      .toBe("leaders still firm if it holds")
    expect(scrubWeeklyTimeframes("watch invalidation if leaders cool this week."))
      .toBe("watch invalidation if leaders cool if it holds.")
    expect(scrubWeeklyTimeframes("worth watching next week"))
      .toBe("worth watching if it holds")
    expect(scrubWeeklyTimeframes("in the next week"))
      .toBe("if it holds")
    expect(scrubWeeklyTimeframes("later this week"))
      .toBe("if it holds")
  })

  it("leaves daily and monthly prose alone", () => {
    expect(scrubWeeklyTimeframes("worth watching into next month"))
      .toBe("worth watching into next month")
    expect(scrubWeeklyTimeframes("watch how it develops today"))
      .toBe("watch how it develops today")
    expect(scrubWeeklyTimeframes("if volume holds"))
      .toBe("if volume holds")
  })
})

describe("scrubWatchProse", () => {
  it("scrubs hour tokens and weekly timeframes together", () => {
    expect(scrubWatchProse("worth watching over the coming week, 72h target"))
      .toBe("worth watching if it holds, the next few days target")
  })
})

describe("watchWindowForHours", () => {
  it("maps settlement buckets for scrub defaults", () => {
    expect(watchWindowForHours(24)).toBe("the next day")
    expect(watchWindowForHours(72)).toBe("the next few days")
    expect(watchWindowForHours(168)).toBe("this month")
  })
})
