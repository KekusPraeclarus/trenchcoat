import { describe, expect, it } from "vitest"
import {
  deriveWatchWindow,
  scrubLeakedHourHorizons,
  watchWindowForHours,
} from "../../src/lib/watch-window.js"

describe("deriveWatchWindow", () => {
  it("keeps token claims close to the hour bucket", () => {
    expect(deriveWatchWindow({ type: "token-upside", horizonHours: 24 }))
      .toBe("the next day")
    expect(deriveWatchWindow({ type: "token-upside", horizonHours: 72 }))
      .toBe("the next few days")
    expect(deriveWatchWindow({ type: "token-upside", horizonHours: 168 }))
      .toBe("the coming weeks")
  })

  it("bumps narrative/rotation one communicative bucket longer", () => {
    expect(deriveWatchWindow({ type: "rotation", horizonHours: 72 }))
      .toBe("this week")
    expect(deriveWatchWindow({ type: "narrative-emergence", horizonHours: 168 }))
      .toBe("through next month")
    expect(deriveWatchWindow({ type: "narrative-fade", horizonHours: 96 }))
      .toBe("this month")
  })
})

describe("scrubLeakedHourHorizons", () => {
  it("scrubs leaked hour tokens and wrappers", () => {
    expect(scrubLeakedHourHorizons("over the next 72h")).toBe("the next few days")
    expect(scrubLeakedHourHorizons("in 72 hr")).toBe("in the next few days")
    expect(scrubLeakedHourHorizons("watch 72h")).toBe("watch the next few days")
    expect(scrubLeakedHourHorizons("over the next 24h")).toBe("the next day")
    expect(scrubLeakedHourHorizons("in the next 168 hours")).toBe("this week")
  })

  it("leaves natural watch prose alone", () => {
    expect(scrubLeakedHourHorizons("watch this week")).toBe("watch this week")
    expect(scrubLeakedHourHorizons("through next month")).toBe("through next month")
    expect(scrubLeakedHourHorizons("the coming weeks")).toBe("the coming weeks")
  })
})

describe("watchWindowForHours", () => {
  it("maps settlement buckets for scrub defaults", () => {
    expect(watchWindowForHours(24)).toBe("the next day")
    expect(watchWindowForHours(72)).toBe("the next few days")
    expect(watchWindowForHours(168)).toBe("this week")
  })
})
