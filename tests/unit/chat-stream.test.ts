import { describe, expect, it } from "vitest"
import {
  applyAssistantDelta,
  createNdjsonParser,
  extractAssistantText,
  extractResultText,
} from "../../src/lib/cursor-stream.js"
import { allocateDraftId, createDraftStream } from "../../src/chat/draft.js"
import { handleChatUpdate } from "../../src/chat/handler.js"
import { buildCursorCliArgs } from "../../src/orchestrator/session.js"

describe("stream-json deltas", () => {
  it("merges fragment deltas and cumulative snapshots", () => {
    let acc = ""
    acc = applyAssistantDelta(acc, "hello")
    acc = applyAssistantDelta(acc, " stream")
    acc = applyAssistantDelta(acc, " test")
    expect(acc).toBe("hello stream test")
    acc = applyAssistantDelta(acc, "hello stream test")
    expect(acc).toBe("hello stream test")
  })

  it("parses assistant and result events from NDJSON", () => {
    const events: unknown[] = []
    const parser = createNdjsonParser((event) => events.push(event))
    parser.push(
      [
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "yo" }] },
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "yo",
        }),
        "",
      ].join("\n"),
    )
    parser.flush()
    expect(extractAssistantText(events[0])).toBe("yo")
    expect(extractResultText(events[1])).toBe("yo")
  })
})

describe("telegram draft stream", () => {
  it("sends thinking placeholder then throttled updates", async () => {
    const sent: Array<{ draftId: number; text: string }> = []
    let now = 1_000
    const draft = createDraftStream({
      draftId: 7,
      minIntervalMs: 100,
      nowMs: () => now,
      transport: {
        sendDraft: async (draftId, text) => {
          sent.push({ draftId, text })
        },
      },
    })

    await draft.begin()
    expect(sent).toEqual([{ draftId: 7, text: "" }])

    await draft.update("hel")
    now = 1_050
    await draft.update("hello")
    await draft.flush()
    expect(sent.at(-1)).toEqual({ draftId: 7, text: "hello" })
    expect(allocateDraftId()).toBeGreaterThan(0)
  })
})

describe("chat handler streaming", () => {
  it("pipes partials through the draft then sends the final message", async () => {
    const draftCalls: string[] = []
    const sent: string[] = []
    await handleChatUpdate({
      chatId: "ops",
      userId: "ops",
      text: "summarize",
      allowlist: ["ops"],
      replyChatId: "ops",
      openDraft: () => ({
        begin: async () => {
          draftCalls.push("begin")
        },
        update: async (text) => {
          draftCalls.push(`u:${text}`)
        },
        flush: async () => {
          draftCalls.push("flush")
        },
      }),
      runTurn: async (_text, sink) => {
        await sink?.onPartial?.("one")
        await sink?.onPartial?.("one two")
        return "one two"
      },
      send: async (_chatId, text) => {
        sent.push(text)
      },
    })
    expect(draftCalls).toEqual(["begin", "u:one", "u:one two", "flush"])
    expect(sent).toEqual(["one two"])
  })
})

describe("cursor argv streaming", () => {
  it("enables stream-json partial output for chat", () => {
    const args = buildCursorCliArgs({
      prompt: "Follow skills/chat/SKILL.md",
      cwd: "/tmp/agent",
      outputFormat: "stream-json",
      streamPartial: true,
      mode: "ask",
    })
    expect(args).toContain("stream-json")
    expect(args).toContain("--stream-partial-output")
    expect(args).toContain("ask")
  })

  it("rejects streamPartial without stream-json", () => {
    expect(() => buildCursorCliArgs({
      prompt: "x",
      cwd: "/tmp",
      streamPartial: true,
    })).toThrow(/stream-json/u)
  })
})
