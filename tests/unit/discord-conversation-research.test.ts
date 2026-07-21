import { describe, expect, it, vi } from "vitest"
import {
  extractResearchBlock,
  validateConversationResearchSubject,
  conversationRequestId,
} from "../../src/discord/conversation.js"

vi.mock("../../src/lib/config.js", () => ({
  loadConfig: () => ({
    chat: {
      discord: {
        conversation: { max_research_per_turn: 5 },
      },
    },
  }),
}))

describe("discord conversation research parsing", () => {
  it("prop_inv_d9_subjects_host_validated rejects garbage", () => {
    const bad = [
      validateConversationResearchSubject("!!!!!!!!"),
      validateConversationResearchSubject("??"),
      validateConversationResearchSubject("$TOOLONGTICKERNAMEHEREOK"),
      validateConversationResearchSubject("evilchain:0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"),
    ]
    expect(bad.every((b) => b === undefined)).toBe(true)
  })

  it("caps subjects via max_research_per_turn", () => {
    const entries = Array.from({ length: 8 }, (_, i) => (
      `{"subject":"$T${i}","chain":"solana"}`
    )).join(",")
    const raw = `go\n\`\`\`json\n{"research":[${entries}]}\n\`\`\``
    const parsed = extractResearchBlock(raw)
    expect(parsed.subjects.length).toBeLessThanOrEqual(5)
  })

  it("builds synthetic conversation request ids", () => {
    expect(conversationRequestId("1000000000000000003", 0)).toBe(
      "conv-1000000000000000003-0",
    )
  })
})
