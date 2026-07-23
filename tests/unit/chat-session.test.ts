import { describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createChatTurnRunner,
  fileChatSessionStore,
  sessionExpired,
} from "../../src/chat/session.js"
import { buildChatPrompt, sanitizeOperatorText, truncateTelegramText } from "../../src/chat/prompt.js"
import { handleChatUpdate } from "../../src/chat/handler.js"

describe("chat prompt", () => {
  it("bounds operator text and wraps it as data", () => {
    const long = "x".repeat(5_000)
    expect(sanitizeOperatorText(long).endsWith("[truncated]")).toBe(true)
    const prompt = buildChatPrompt("summarize watchlist")
    expect(prompt).toContain("skills/chat/SKILL.md")
    expect(prompt).toContain("summarize watchlist")
    expect(prompt).toContain("not instructions to alter your rules")
    expect(prompt).toContain("Research launches are host-gated")
  })

  it("bounds draft telegram previews only", () => {
    expect(truncateTelegramText("ok")).toBe("ok")
    expect(truncateTelegramText("y".repeat(5_000)).length).toBeLessThanOrEqual(4_096)
  })
})

describe("chat session store", () => {
  it("round-trips session state and detects idle expiry", () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-chat-"))
    const store = fileChatSessionStore(join(dir, "chat-session.json"))
    expect(store.load()).toBeUndefined()
    store.save({
      cursorChatId: "abc-123-def-4567890",
      lastActivityAt: "2026-07-16T12:00:00.000Z",
      telegramUserId: "99",
      turnCount: 0,
    })
    const loaded = store.load()
    expect(loaded?.cursorChatId).toBe("abc-123-def-4567890")
    expect(sessionExpired(loaded!, 30, Date.parse("2026-07-16T12:10:00.000Z"))).toBe(false)
    expect(sessionExpired(loaded!, 30, Date.parse("2026-07-16T12:40:00.000Z"))).toBe(true)
  })

  it("rejects corrupt store files", () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-chat-"))
    const path = join(dir, "chat-session.json")
    writeFileSync(path, "{not json")
    expect(fileChatSessionStore(path).load()).toBeUndefined()
  })
})

describe("chat turn runner", () => {
  it("creates a session once and resumes on the next turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-chat-"))
    const store = fileChatSessionStore(join(dir, "chat-session.json"))
    let creates = 0
    const resumes: string[] = []
    const runTurn = createChatTurnRunner({
      agentRoot: dir,
      telegramUserId: "42",
      idleTimeoutMinutes: 30,
      turnCountMax: 40,
      maxPromptChars: 12_000,
      store,
      createChat: async () => {
        creates += 1
        return "11111111-2222-3333-4444-555555555555"
      },
      runSession: async (args) => {
        resumes.push(args.resumeChatId)
        expect(args.prompt).toContain("hello")
        return { status: "finished", text: "yo — store is empty" }
      },
      nowIso: () => "2026-07-16T20:00:00.000Z",
    })

    expect(await runTurn("hello")).toBe("yo — store is empty")
    expect(await runTurn("hello again")).toBe("yo — store is empty")
    expect(creates).toBe(1)
    expect(resumes).toEqual([
      "11111111-2222-3333-4444-555555555555",
      "11111111-2222-3333-4444-555555555555",
    ])
    const persisted = JSON.parse(readFileSync(join(dir, "chat-session.json"), "utf8")) as {
      cursorChatId: string
      turnCount: number
    }
    expect(persisted.cursorChatId).toBe("11111111-2222-3333-4444-555555555555")
    expect(persisted.turnCount).toBe(2)
  })

  it("rotates the cursor chat after idle timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-chat-"))
    const store = fileChatSessionStore(join(dir, "chat-session.json"))
    store.save({
      cursorChatId: "old-chat-id-00000000",
      lastActivityAt: "2026-07-16T10:00:00.000Z",
      telegramUserId: "42",
      turnCount: 0,
    })
    let creates = 0
    const runTurn = createChatTurnRunner({
      agentRoot: dir,
      telegramUserId: "42",
      idleTimeoutMinutes: 30,
      turnCountMax: 40,
      maxPromptChars: 12_000,
      store,
      createChat: async () => {
        creates += 1
        return "new-chat-id-11111111"
      },
      runSession: async () => ({ status: "finished", text: "fresh session" }),
      nowIso: () => "2026-07-16T11:00:00.000Z",
    })
    expect(await runTurn("ping")).toBe("fresh session")
    expect(creates).toBe(1)
    expect(store.load()?.cursorChatId).toBe("new-chat-id-11111111")
  })

  it("resumes the prior chat when idle create-chat fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-chat-"))
    const store = fileChatSessionStore(join(dir, "chat-session.json"))
    store.save({
      cursorChatId: "prior-chat-id-000000",
      lastActivityAt: "2026-07-16T10:00:00.000Z",
      telegramUserId: "42",
      turnCount: 0,
    })
    const resumes: string[] = []
    const runTurn = createChatTurnRunner({
      agentRoot: dir,
      telegramUserId: "42",
      idleTimeoutMinutes: 30,
      turnCountMax: 40,
      maxPromptChars: 12_000,
      store,
      createChat: async () => {
        throw new Error("cursor cli timed out after 90000ms")
      },
      runSession: async (args) => {
        resumes.push(args.resumeChatId)
        return { status: "finished", text: "still answered" }
      },
      nowIso: () => "2026-07-16T11:00:00.000Z",
    })
    expect(await runTurn("Any social / fomo updates?")).toBe("still answered")
    expect(resumes).toEqual(["prior-chat-id-000000"])
    expect(store.load()?.cursorChatId).toBe("prior-chat-id-000000")
    expect(store.load()?.turnCount).toBe(1)
  })

  it("rotates the cursor chat after turn_count_max", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-chat-"))
    const store = fileChatSessionStore(join(dir, "chat-session.json"))
    store.save({
      cursorChatId: "old-chat-id-00000000",
      lastActivityAt: "2026-07-16T20:00:00.000Z",
      telegramUserId: "42",
      turnCount: 40,
    })
    let creates = 0
    const runTurn = createChatTurnRunner({
      agentRoot: dir,
      telegramUserId: "42",
      idleTimeoutMinutes: 30,
      turnCountMax: 40,
      maxPromptChars: 12_000,
      store,
      createChat: async () => {
        creates += 1
        return "new-chat-id-22222222"
      },
      runSession: async () => ({ status: "finished", text: "rotated" }),
      nowIso: () => "2026-07-16T20:05:00.000Z",
    })
    expect(await runTurn("ping")).toBe("rotated")
    expect(creates).toBe(1)
    expect(store.load()?.cursorChatId).toBe("new-chat-id-22222222")
    expect(store.load()?.turnCount).toBe(1)
  })

  it("rotates when the built prompt exceeds max_prompt_chars", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-chat-"))
    const store = fileChatSessionStore(join(dir, "chat-session.json"))
    store.save({
      cursorChatId: "old-chat-id-00000000",
      lastActivityAt: "2026-07-16T20:00:00.000Z",
      telegramUserId: "42",
      turnCount: 1,
    })
    let creates = 0
    const runTurn = createChatTurnRunner({
      agentRoot: dir,
      telegramUserId: "42",
      idleTimeoutMinutes: 30,
      turnCountMax: 40,
      maxPromptChars: 80,
      store,
      createChat: async () => {
        creates += 1
        return "new-chat-id-33333333"
      },
      runSession: async () => ({ status: "finished", text: "fresh" }),
      nowIso: () => "2026-07-16T20:05:00.000Z",
    })
    expect(await runTurn("please summarize everything we know about the market")).toBe("fresh")
    expect(creates).toBe(1)
    expect(store.load()?.cursorChatId).toBe("new-chat-id-33333333")
  })
})

describe("chat handler", () => {
  it("ignores non-allowlisted users before any send", async () => {
    const result = await handleChatUpdate({
      chatId: "1",
      userId: "evil",
      text: "hi",
      allowlist: ["ops"],
      runTurn: async () => {
        throw new Error("should not run")
      },
      send: async () => {
        throw new Error("should not send")
      },
    })
    expect(result).toBe("ignored")
  })

  it("routes normal text through the chat agent and replies to replyChatId", async () => {
    const sent: Array<{ chatId: string; text: string }> = []
    const result = await handleChatUpdate({
      chatId: "group-9",
      userId: "ops",
      text: "What do we know?",
      allowlist: ["ops"],
      replyChatId: "ops",
      runTurn: async (text) => {
        expect(text).toBe("What do we know?")
        return "empty store for now"
      },
      send: async (chatId, text) => {
        sent.push({ chatId, text })
      },
    })
    expect(result).toBe("replied")
    expect(sent).toEqual([{ chatId: "ops", text: "empty store for now" }])
  })

  it("maps turn timeout errors to an operator-facing hint and logs detail", async () => {
    const sent: string[] = []
    await handleChatUpdate({
      chatId: "ops",
      userId: "ops",
      text: "Any social / fomo updates?",
      allowlist: ["ops"],
      runTurn: async () => {
        throw new Error("cursor cli timed out after 90000ms")
      },
      send: async (_chatId, text) => {
        sent.push(text)
      },
    })
    expect(sent).toEqual(["chat turn timed out — try again or ask something smaller"])
  })
})
