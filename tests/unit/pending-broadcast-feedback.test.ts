import { describe, expect, it } from "vitest"
import { bindFeedbackReply } from "../../src/chat/pending-broadcast-feedback.js"
import type { PendingFollowup } from "../../src/broadcast-feedback/schemas.js"

const NOW = "2026-08-10T00:00:00.000Z"

function pending(overrides: Partial<PendingFollowup> = {}): PendingFollowup {
  return {
    feedbackId: "fb-0123456789abcdef",
    eventId: `sha256:${"a".repeat(64)}`,
    state: "down",
    requestedAt: "2026-08-09T00:00:00.000Z",
    expiresAt: "2026-08-12T00:00:00.000Z",
    ...overrides,
  }
}

describe("feedback reply binding", () => {
  it("binds a bare reply when one request is open", () => {
    expect(bindFeedbackReply({ pending: [pending()], nowIso: NOW })).toEqual({
      kind: "bound",
      feedbackId: "fb-0123456789abcdef",
    })
  })

  it("binds a direct reply to its own prompt", () => {
    const first = pending({ promptMessageId: "11" })
    const second = pending({
      feedbackId: "fb-fedcba9876543210",
      promptMessageId: "12",
    })
    expect(bindFeedbackReply({
      pending: [first, second],
      nowIso: NOW,
      replyToMessageId: "12",
    })).toEqual({ kind: "bound", feedbackId: "fb-fedcba9876543210" })
  })

  it("asks for a direct reply when several requests are open", () => {
    const result = bindFeedbackReply({
      pending: [pending(), pending({ feedbackId: "fb-fedcba9876543210" })],
      nowIso: NOW,
    })
    expect(result).toEqual({ kind: "ambiguous", open: 2 })
  })

  it("binds nothing when no request is open", () => {
    expect(bindFeedbackReply({ pending: [], nowIso: NOW })).toEqual({ kind: "none" })
  })

  it("ignores expired requests", () => {
    const expired = pending({ expiresAt: "2026-08-09T12:00:00.000Z" })
    expect(bindFeedbackReply({ pending: [expired], nowIso: NOW })).toEqual({ kind: "none" })
  })

  it("binds nothing when a reply points at an unknown prompt", () => {
    expect(bindFeedbackReply({
      pending: [pending({ promptMessageId: "11" })],
      nowIso: NOW,
      replyToMessageId: "99",
    })).toEqual({ kind: "none" })
  })
})
