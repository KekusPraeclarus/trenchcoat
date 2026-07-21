import { describe, expect, it } from "vitest"
import {
  reclaimStaleConversationClaims,
  SYNTHESIS_LEASE_MS,
} from "../../src/discord/conversation.js"

describe("crash discord conversation", () => {
  it("reverts synthesizing lease after timeout without losing conversation id", () => {
    const nowIso = "2026-07-21T15:00:00.000Z"
    const claimedAt = new Date(Date.parse(nowIso) - SYNTHESIS_LEASE_MS - 5_000).toISOString()
    const file = {
      schema: 1 as const,
      conversations: [{
        conversationId: "1000000000000000099",
        guildId: "1000000000000000001",
        channelId: "1000000000000000002",
        userId: "1000000000000000004",
        question: "compare karma and wallet",
        cursorChatId: "cursor-chat",
        requestIds: [
          "conv-1000000000000000099-0",
          "conv-1000000000000000099-1",
        ],
        status: "synthesizing" as const,
        createdAt: claimedAt,
        updatedAt: claimedAt,
        claimedAt,
      }],
    }
    const next = reclaimStaleConversationClaims(file, nowIso)
    expect(next.conversations).toHaveLength(1)
    expect(next.conversations[0]!.status).toBe("awaiting-research")
    expect(next.conversations[0]!.requestIds).toHaveLength(2)
    expect(next.conversations[0]!.conversationId).toBe("1000000000000000099")
  })
})
