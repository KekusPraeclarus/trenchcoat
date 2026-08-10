import { describe, expect, it } from "vitest"
import { handleChatUpdate } from "../../src/chat/handler.js"

const OPERATOR = "9001"

function scaffold(handle: (args: {
  text: string
  replyToMessageId?: string
}) => Promise<string | null>) {
  const sent: string[] = []
  const seen: Array<{ text: string; replyToMessageId?: string }> = []
  return {
    sent,
    seen,
    run: (text: string, replyToMessageId?: string) => handleChatUpdate({
      chatId: OPERATOR,
      userId: OPERATOR,
      text,
      allowlist: [OPERATOR],
      send: async (_chatId, body) => { sent.push(body) },
      broadcastFeedback: {
        handle: async (args) => {
          seen.push(args)
          return handle(args)
        },
      },
      runTurn: async () => "agent reply",
      ...(replyToMessageId ? { replyToMessageId } : {}),
    }),
  }
}

describe("chat handler broadcast feedback", () => {
  it("answers with the feedback acknowledgement when a request is open", async () => {
    const s = scaffold(async () => "Feedback recorded: tone.")
    const outcome = await s.run("the tone was off")
    expect(outcome).toBe("replied")
    expect(s.sent).toEqual(["Feedback recorded: tone."])
  })

  it("passes the reply reference through to the hook", async () => {
    const s = scaffold(async () => "Feedback recorded: accuracy.")
    await s.run("wrong direction", "4242")
    expect(s.seen[0]).toEqual({ text: "wrong direction", replyToMessageId: "4242" })
  })

  it("falls through to normal chat when nothing binds", async () => {
    const s = scaffold(async () => null)
    const outcome = await s.run("what is the watchlist doing")
    expect(outcome).toBe("replied")
    expect(s.sent[0]).toBe("agent reply")
  })

  it("reports a failure instead of throwing", async () => {
    const s = scaffold(async () => { throw new Error("classifier offline") })
    await s.run("too long")
    expect(s.sent[0]).toContain("feedback failed: classifier offline")
  })

  it("keeps host commands ahead of feedback", async () => {
    const s = scaffold(async () => "Feedback recorded: tone.")
    await s.run("/start")
    expect(s.seen).toHaveLength(0)
  })

  it("ignores a user outside the allowlist", async () => {
    const sent: string[] = []
    const outcome = await handleChatUpdate({
      chatId: "1",
      userId: "1",
      text: "the tone was off",
      allowlist: [OPERATOR],
      send: async (_chatId, body) => { sent.push(body) },
      broadcastFeedback: { handle: async () => "Feedback recorded: tone." },
    })
    expect(outcome).toBe("ignored")
    expect(sent).toHaveLength(0)
  })
})
