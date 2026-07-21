import { describe, expect, it } from "vitest"
import {
  DiscordTrackingFileSchema,
  TrackingRequestRecordSchema,
} from "../../src/discord/schemas.js"
import { emptyTrackingFile } from "../../src/discord/store.js"

const NOW = "2026-07-21T12:00:00.000Z"

function sampleRequest(overrides: Record<string, unknown> = {}) {
  return TrackingRequestRecordSchema.parse({
    trackingId: "trk-test123456",
    guildId: "1000000000000000001",
    channelId: "1000000000000000002",
    messageId: "1000000000000000003",
    userId: "1000000000000000004",
    description: "privacy mixer on RH with decent backing",
    shortLabel: "Privacy on RH",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: "2026-08-20T12:00:00.000Z",
    extensionCount: 0,
    matchedSubjects: [],
    ...overrides,
  })
}

describe("discord tracking schema", () => {
  it("accepts empty file", () => {
    expect(DiscordTrackingFileSchema.parse(emptyTrackingFile())).toEqual({
      schema: 1,
      requests: [],
      matchBatches: [],
      trackingDeliveries: [],
    })
  })

  it("accepts every request status", () => {
    for (const status of [
      "active",
      "pending-capacity",
      "tentative",
      "expired-awaiting-reply",
      "expired-final",
      "dropped",
    ] as const) {
      expect(sampleRequest({ status }).status).toBe(status)
    }
  })

  it("rejects malformed tracking ids and overlong description", () => {
    expect(() => sampleRequest({ trackingId: "bad" })).toThrow()
    expect(() => sampleRequest({ description: "x".repeat(501) })).toThrow()
    expect(() => sampleRequest({ guildId: "not-a-snowflake" })).toThrow()
  })

  it("rejects unknown status", () => {
    expect(() => sampleRequest({ status: "weird" })).toThrow()
  })

  it("round-trips a full file", () => {
    const file = DiscordTrackingFileSchema.parse({
      schema: 1,
      requests: [sampleRequest()],
      matchBatches: [{
        batchId: "a".repeat(32),
        sourceKind: "list-scan",
        runId: "list-scan-1",
        snapshotHash: "b".repeat(32),
        status: "pending",
        attemptCount: 0,
        createdAt: NOW,
        updatedAt: NOW,
        candidateDigest: "[]",
      }],
      trackingDeliveries: [{
        deliveryId: "c".repeat(32),
        trackingId: "trk-test123456",
        subject: "FOO",
        normalizedSubject: "foo",
        reason: "new privacy mixer",
        status: "pending",
        guildId: "1000000000000000001",
        channelId: "1000000000000000002",
        userId: "1000000000000000004",
        anchorMessageId: "1000000000000000003",
        parts: [],
        deliveredPartKeys: [],
        discordMessageIds: [],
        attemptCount: 0,
        createdAt: NOW,
        updatedAt: NOW,
        batchId: "a".repeat(32),
        sourceKind: "list-scan",
        needsResearch: true,
        researchEnqueued: false,
      }],
    })
    expect(file.requests).toHaveLength(1)
    expect(file.matchBatches).toHaveLength(1)
    expect(file.trackingDeliveries).toHaveLength(1)
  })
})
