import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  extractResearchIntent,
  isCancelText,
  isConfirmText,
  parseResearchIntent,
} from "../../src/chat/research-intent.js"
import {
  cancelPending,
  clearExpiredPending,
  confirmPending,
  filePendingResearchStore,
  proposeResearch,
} from "../../src/chat/pending-research.js"
import { handleChatUpdate } from "../../src/chat/handler.js"

describe("research intent", () => {
  it("fail-closed parse defaults to chat", () => {
    expect(parseResearchIntent("not json").kind).toBe("chat")
    expect(parseResearchIntent('{"schema":1,"kind":"research"}').kind).toBe("chat")
    expect(parseResearchIntent(
      '{"schema":1,"kind":"research","subject":"BONK","confidence":80}',
    )).toMatchObject({ kind: "research", subject: "BONK" })
  })

  it("extracts clear research requests and ignores chat", () => {
    expect(extractResearchIntent("what is on the watchlist?").kind).toBe("chat")
    expect(extractResearchIntent("research BONK on solana")).toMatchObject({
      kind: "research",
      chainHint: "solana",
    })
    expect(extractResearchIntent(
      "solana:So11111111111111111111111111111111111111112",
    )).toMatchObject({
      kind: "research",
      chainHint: "solana",
      confidence: 95,
    })
    expect(extractResearchIntent("/research WIF")).toMatchObject({
      kind: "research",
      subject: "WIF",
    })
    expect(extractResearchIntent("Run deep research on $REPPO")).toMatchObject({
      kind: "research",
      subject: "REPPO",
      confidence: 70,
    })
    expect(extractResearchIntent("research $REPPO on Base")).toMatchObject({
      kind: "research",
      subject: "REPPO",
      chainHint: "base",
      confidence: 80,
    })
    expect(extractResearchIntent("research eth REPPO on base")).toMatchObject({
      kind: "research",
      subject: "REPPO",
      chainHint: "base",
    })
  })

  it("confirm prompt names the chain when hinted", async () => {
    const { researchConfirmPrompt } = await import("../../src/chat/research-intent.js")
    expect(researchConfirmPrompt({
      schema: 1,
      kind: "research",
      subject: "REPPO",
      chainHint: "base",
      confidence: 80,
    })).toBe("Research REPPO on base? Reply confirm or cancel.")
  })

  it("recognises confirm and cancel", () => {
    expect(isConfirmText("confirm")).toBe(true)
    expect(isConfirmText("yes")).toBe(true)
    expect(isCancelText("cancel")).toBe(true)
    expect(isCancelText("never mind")).toBe(true)
    expect(isConfirmText("confirm later")).toBe(false)
  })
})

describe("pending research store", () => {
  it("proposes, expires, confirms, and cancels", () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-pending-"))
    const store = filePendingResearchStore(join(dir, "pending-research.json"))
    const intent = extractResearchIntent("research BONK")
    expect(intent.kind).toBe("research")

    let file = store.load()
    const proposed = proposeResearch({
      file,
      telegramUserId: "ops",
      intent,
      nowIso: "2026-07-17T12:00:00.000Z",
      ttlMinutes: 15,
    })
    store.save(proposed.file)
    expect(store.load().pending?.subject).toContain("BONK")

    const expired = clearExpiredPending(
      store.load(),
      "2026-07-17T12:20:00.000Z",
    )
    expect(expired.pending).toBeNull()

    store.save(proposed.file)
    const cancelled = cancelPending(store.load(), "ops")
    expect(cancelled.pending).toBeNull()

    store.save(proposed.file)
    const confirmed = confirmPending({
      file: store.load(),
      telegramUserId: "ops",
      nowIso: "2026-07-17T12:05:00.000Z",
    })
    expect(confirmed.confirmed?.status).toBe("queued")
    expect(confirmed.file.pending).toBeNull()
    store.save(confirmed.file)
    expect(store.load().confirmed).toHaveLength(1)
  })

  it("rejects confirm from a different operator id", () => {
    const intent = extractResearchIntent("research WIF")
    const proposed = proposeResearch({
      file: { schema: 1, telegramUserId: "ops", pending: null, pendingChoice: null, confirmed: [] },
      telegramUserId: "ops",
      intent,
      nowIso: "2026-07-17T12:00:00.000Z",
      ttlMinutes: 15,
    })
    const result = confirmPending({
      file: proposed.file,
      telegramUserId: "evil",
      nowIso: "2026-07-17T12:01:00.000Z",
    })
    expect(result.error).toMatch(/another operator/u)
    expect(result.confirmed).toBeUndefined()
  })
})

describe("chat handler research gate", () => {
  it("proposes research and only launches after confirm", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-chat-research-"))
    const store = filePendingResearchStore(join(dir, "pending-research.json"))
    const sent: string[] = []
    let confirmedIds: string[] = []
    let agentRuns = 0

    await handleChatUpdate({
      chatId: "ops",
      userId: "ops",
      text: "research BONK on solana",
      allowlist: ["ops"],
      replyChatId: "ops",
      research: {
        store,
        ttlMinutes: 15,
        nowIso: () => "2026-07-17T12:00:00.000Z",
        onConfirmed: (id) => { confirmedIds.push(id) },
      },
      runTurn: async () => {
        agentRuns += 1
        return "should not run"
      },
      send: async (_chatId, text) => { sent.push(text) },
    })
    expect(agentRuns).toBe(0)
    expect(sent[0]).toMatch(/Reply confirm or cancel/u)
    expect(store.load().pending?.subject).toBeTruthy()

    await handleChatUpdate({
      chatId: "ops",
      userId: "ops",
      text: "confirm",
      allowlist: ["ops"],
      replyChatId: "ops",
      research: {
        store,
        ttlMinutes: 15,
        nowIso: () => "2026-07-17T12:01:00.000Z",
        onConfirmed: (id) => { confirmedIds.push(id) },
      },
      runTurn: async () => {
        agentRuns += 1
        return "nope"
      },
      send: async (_chatId, text) => { sent.push(text) },
    })
    expect(agentRuns).toBe(0)
    expect(confirmedIds).toHaveLength(1)
    expect(store.load().confirmed[0]?.status).toBe("queued")
    expect(sent.at(-1)).toMatch(/confirmed/u)
  })

  it("confirm with empty store replies without throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-chat-research-"))
    const store = filePendingResearchStore(join(dir, "pending-research.json"))
    const sent: string[] = []
    await handleChatUpdate({
      chatId: "ops",
      userId: "ops",
      text: "confirm",
      allowlist: ["ops"],
      replyChatId: "ops",
      research: {
        store,
        ttlMinutes: 15,
        nowIso: () => "2026-07-17T12:00:00.000Z",
      },
      runTurn: async () => "should not run",
      send: async (_chatId, text) => { sent.push(text) },
    })
    expect(sent[0]).toMatch(/no pending/iu)
    expect(store.load().pending).toBeNull()
  })

  it("asks the operator to pick when multiple CAs are credible", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-chat-research-"))
    const store = filePendingResearchStore(join(dir, "pending-research.json"))
    const sent: string[] = []
    const {
      proposeResearchChoice,
      selectResearchChoice,
      formatResearchChoicePrompt,
    } = await import("../../src/chat/pending-research.js")

    let file = store.load()
    file = {
      ...file,
      telegramUserId: "ops",
      confirmed: [{
        requestId: "rr-1",
        subject: "REPPO",
        status: "awaiting-choice",
        confirmedAt: "2026-07-17T12:00:00.000Z",
        updatedAt: "2026-07-17T12:00:00.000Z",
        completionNotified: false,
      }],
    }
    const proposed = proposeResearchChoice({
      file,
      telegramUserId: "ops",
      requestId: "rr-1",
      subject: "REPPO",
      shortlist: [
        {
          chain: "base",
          tokenAddress: "0xFf8104251E7761163faC3211eF5583FB3F8583d6",
          pairAddress: "0xdf7470b0Fc66F216aD687416958C115e72AaD1fb",
          symbolDisplay: "REPPO",
          resolution: "ambiguous",
        },
        {
          chain: "ethereum",
          tokenAddress: "0x5109A19e14766245320fAbC794b92F05f3cFa1B4",
          pairAddress: "0xf2A3CFDbE0f9Ab377B0cf8B38B589f3d74f3FF2e",
          symbolDisplay: "REPPO",
          resolution: "ambiguous",
        },
      ],
      nowIso: "2026-07-17T12:00:00.000Z",
      ttlMinutes: 15,
    })
    store.save(proposed.file)
    expect(proposed.prompt).toContain("base:")
    expect(proposed.prompt).toContain("ethereum:")
    expect(formatResearchChoicePrompt({
      subject: "REPPO",
      options: proposed.choice.options,
    })).toMatch(/1\. base:/u)

    await handleChatUpdate({
      chatId: "ops",
      userId: "ops",
      text: "1",
      allowlist: ["ops"],
      replyChatId: "ops",
      research: {
        store,
        ttlMinutes: 15,
        nowIso: () => "2026-07-17T12:01:00.000Z",
      },
      send: async (_c, text) => { sent.push(text) },
    })
    expect(sent.at(-1)).toMatch(/selected base:/iu)
    expect(store.load().pendingChoice).toBeNull()
    expect(store.load().confirmed[0]?.status).toBe("queued")
    expect(store.load().confirmed[0]?.chainHint).toBe("base")

    const again = selectResearchChoice({
      file: store.load(),
      telegramUserId: "ops",
      nowIso: "2026-07-17T12:02:00.000Z",
      selection: "2",
    })
    expect(again.error).toMatch(/no pending shortlist/iu)
  })

  it("ignores non-allowlisted research attempts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-chat-research-"))
    const store = filePendingResearchStore(join(dir, "pending-research.json"))
    const result = await handleChatUpdate({
      chatId: "evil",
      userId: "evil",
      text: "research BONK",
      allowlist: ["ops"],
      research: { store, ttlMinutes: 15 },
      send: async () => {
        throw new Error("should not send")
      },
    })
    expect(result).toBe("ignored")
    expect(store.load().pending).toBeNull()
  })
})
