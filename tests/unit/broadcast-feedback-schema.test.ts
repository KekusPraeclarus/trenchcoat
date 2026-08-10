import { describe, expect, it } from "vitest"
import {
  BroadcastFeedbackRecordSchema,
  FeedbackFollowupResultSchema,
  feedbackStateFromReactions,
  followupRequiredFor,
} from "../../src/broadcast-feedback/schemas.js"

const RECORD = {
  schema: 1,
  feedbackId: "fb-0123456789abcdef",
  eventId: "0123456789abcdef0123456789abcdef",
  deliveryId: "del-1",
  runId: "run-1",
  providerMessageId: "100000000000000001",
  partIndex: 0,
  partTotal: 1,
  operatorUserId: "200000000000000002",
  state: "down",
  firstReactionAt: "2026-08-10T00:00:00.000Z",
  lastReactionAt: "2026-08-10T00:00:00.000Z",
  followupStatus: "pending",
  tags: [],
} as const

describe("feedback state rules", () => {
  it("treats both reactions as ambiguous", () => {
    expect(feedbackStateFromReactions({ up: true, down: true })).toBe("ambiguous")
  })

  it("keeps one state when one reaction remains", () => {
    expect(feedbackStateFromReactions({ up: true, down: false })).toBe("up")
    expect(feedbackStateFromReactions({ up: false, down: true })).toBe("down")
  })

  it("treats no reaction as retracted", () => {
    expect(feedbackStateFromReactions({ up: false, down: false })).toBe("retracted")
  })

  it("asks for detail only after down or ambiguous", () => {
    expect(followupRequiredFor("down")).toBe(true)
    expect(followupRequiredFor("ambiguous")).toBe(true)
    expect(followupRequiredFor("up")).toBe(false)
    expect(followupRequiredFor("retracted")).toBe(false)
  })
})

describe("feedback record schema", () => {
  it("accepts a minimal record", () => {
    expect(BroadcastFeedbackRecordSchema.parse(RECORD).state).toBe("down")
  })

  it("rejects a non-Discord operator id", () => {
    expect(() => BroadcastFeedbackRecordSchema.parse({
      ...RECORD,
      operatorUserId: "not-an-id",
    })).toThrow()
  })

  it("rejects an unknown state", () => {
    expect(() => BroadcastFeedbackRecordSchema.parse({
      ...RECORD,
      state: "maybe",
    })).toThrow()
  })
})

describe("follow-up classifier result schema", () => {
  it("needs at least one bounded tag", () => {
    expect(() => FeedbackFollowupResultSchema.parse({
      schema: 1,
      tags: [],
      summary: "no tags",
    })).toThrow()
  })

  it("rejects an unlisted tag", () => {
    expect(() => FeedbackFollowupResultSchema.parse({
      schema: 1,
      tags: ["vibes"],
      summary: "bad tag",
    })).toThrow()
  })

  it("caps the derived summary at 280 characters", () => {
    expect(() => FeedbackFollowupResultSchema.parse({
      schema: 1,
      tags: ["tone"],
      summary: "x".repeat(281),
    })).toThrow()
  })

  it("accepts bounded tags with a short summary", () => {
    const parsed = FeedbackFollowupResultSchema.parse({
      schema: 1,
      tags: ["tone", "too-long"],
      summary: "too formal and too long",
    })
    expect(parsed.tags).toEqual(["tone", "too-long"])
  })
})
