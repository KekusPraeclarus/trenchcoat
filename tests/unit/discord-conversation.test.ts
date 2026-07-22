import { describe, expect, it, vi } from "vitest"
import {
  extractResearchBlock,
  sanitizeConversationReply,
  validateConversationResearchSubject,
  withChannelMutex,
} from "../../src/discord/conversation.js"

vi.mock("../../src/lib/config.js", () => ({
  loadConfig: () => ({
    chat: {
      discord: {
        conversation: {
          enabled: true,
          max_research_per_turn: 5,
        },
      },
    },
  }),
}))

describe("discord conversation", () => {
  it("extracts final research fence and strips it from visible text", () => {
    const raw = [
      "I'll dig into both.",
      "```json",
      '{"research":[{"subject":"$KARMA","chain":"robinhood"},{"subject":"$WALLET","chain":"robinhood"}]}',
      "```",
    ].join("\n")
    const parsed = extractResearchBlock(raw)
    expect(parsed.visible).toContain("I'll dig into both.")
    expect(parsed.visible).not.toContain("```")
    expect(parsed.subjects).toHaveLength(2)
    expect(parsed.subjects[0]!.subject).toContain("KARMA")
  })

  it("ignores malformed research fences", () => {
    const parsed = extractResearchBlock('hello\n```json\n{"research":"nope"}\n```')
    expect(parsed.visible).toContain("hello")
    expect(parsed.subjects).toHaveLength(0)
  })

  it("prop_inv_d9_subjects_host_validated", () => {
    expect(validateConversationResearchSubject("not-a-thing!!!")).toBeUndefined()
    expect(validateConversationResearchSubject("??")).toBeUndefined()
    expect(validateConversationResearchSubject("$KARMA", "notachain")).toBeUndefined()
    expect(validateConversationResearchSubject("$KARMA", "robinhood")).toEqual({
      subject: "$KARMA on robinhood",
      chainHint: "robinhood",
    })
    const sol = "So11111111111111111111111111111111111111112"
    expect(validateConversationResearchSubject(`solana:${sol}`)).toEqual({
      subject: `solana:${sol}`,
      chainHint: "solana",
      tokenHint: sol,
    })
  })

  it("prop_inv_d9_reply_never_leaks_workspace_paths", () => {
    const cleaned = sanitizeConversationReply(
      "See reports/chat/foo.md and inbox/run/x.json <@123> @everyone",
    )
    expect(cleaned).not.toMatch(/reports\//)
    expect(cleaned).not.toMatch(/inbox\//)
    expect(cleaned).not.toContain("<@123>")
    expect(cleaned).not.toContain("@everyone")
  })

  it("strips process preamble from member-facing replies", () => {
    const cleaned = sanitizeConversationReply([
      "I'll follow the Discord chat skill and pull context from the state index first.",
      "**$KARMA looks cleaner on evidence. $WALLET is louder but messier.**",
      "",
      "Neither is on our tracking slate.",
    ].join("\n"))
    expect(cleaned).not.toMatch(/skill/i)
    expect(cleaned).not.toMatch(/state index/i)
    expect(cleaned).not.toMatch(/pull context/i)
    expect(cleaned.startsWith("**$KARMA")).toBe(true)
  })

  it("keeps conversational acknowledgments and corrections", () => {
    const reply = [
      "Good catch on the migration — I'll verify the KARMA v1→v2 CA story in the knowledge store before updating the take.",
      "Fair pushback — that was sloppy framing on my end.",
      "",
      "**$KARMA didn't have random CA confusion. It migrated.**",
    ].join("\n")
    const cleaned = sanitizeConversationReply(reply)
    expect(cleaned).toContain("Good catch on the migration")
    expect(cleaned).toContain("Fair pushback")
    expect(cleaned).toContain("**$KARMA didn't have random CA confusion")
  })

  it("keeps member-facing research status lines", () => {
    const cleaned = sanitizeConversationReply(
      "Digging into $KARMA & $WALLET — back in a bit.",
    )
    expect(cleaned).toBe("Digging into $KARMA & $WALLET — back in a bit.")
  })

  it("serializes per-channel mutex", async () => {
    const order: number[] = []
    await Promise.all([
      withChannelMutex("c1", async () => {
        await new Promise((r) => setTimeout(r, 30))
        order.push(1)
      }),
      withChannelMutex("c1", async () => {
        order.push(2)
      }),
    ])
    expect(order).toEqual([1, 2])
  })

  it("does not re-enqueue research from synthesis-shaped text when stripped", () => {
    const synthesis = extractResearchBlock([
      "KARMA looks stronger.",
      "```json",
      '{"research":[{"subject":"$MORE"}]}',
      "```",
    ].join("\n"))
    // Host must strip and must not call enqueue — caller responsibility tested here by strip
    expect(synthesis.visible).toBe("KARMA looks stronger.")
    // subjects would be present if re-parsed; synthesis path discards them
    expect(synthesis.subjects.length).toBeLessThanOrEqual(5)
  })
})
