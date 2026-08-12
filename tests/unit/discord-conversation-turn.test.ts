import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { handleConversationTurn } from "../../src/discord/conversation.js"
import type { ConversationLiveTape } from "../../src/discord/live-tape.js"
import { createDiscordStore } from "../../src/discord/store.js"
import { discordLayout } from "../../src/discord/paths.js"

const RH_CA = "0xF8BC08092C06dB6148114DCf82AF881F1085f92b"
const CHANNEL_ID = "1000000000000000002"

const resolveConversationCa = vi.fn()
const fetchConversationLiveTape = vi.fn()

vi.mock("../../src/discord/live-tape.js", () => ({
  resolveConversationCa: (...args: unknown[]) => resolveConversationCa(...args),
  fetchConversationLiveTape: (...args: unknown[]) => fetchConversationLiveTape(...args),
  formatLiveTapePromptLines: () => [],
}))

vi.mock("../../src/discord/agent-setup.js", () => ({
  ensureDiscordAgentWorkspace: () => undefined,
  readDiscordChatReport: () => undefined,
}))

vi.mock("../../src/lib/config.js", () => ({
  loadConfig: () => ({
    chat: {
      discord: {
        enabled: true,
        channel_ids: [CHANNEL_ID],
        conversation: {
          enabled: true,
          model: "composer-2.5",
          classifier_model: "composer-2.5-fast",
          idle_timeout_minutes: 30,
          context_messages: 10,
          channel_ids: [],
          max_research_per_turn: 5,
        },
      },
    },
  }),
}))

describe("discord conversation turn live tape", () => {
  let home: string
  let previousHome: string | undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tc-conv-turn-"))
    previousHome = process.env["HOME"]
    process.env["HOME"] = home
    resolveConversationCa.mockReset()
    fetchConversationLiveTape.mockReset()
  })

  afterEach(() => {
    if (previousHome === undefined) delete process.env["HOME"]
    else process.env["HOME"] = previousHome
    rmSync(home, { recursive: true, force: true })
  })

  it("prefetches live tape before runner on CA message", async () => {
    const order: string[] = []
    const liveTape: ConversationLiveTape = {
      status: "ok",
      chain: "robinhood",
      tokenAddress: RH_CA,
      symbol: "NUKED",
      fdvUsd: 12_000,
      liquidityUsd: 500,
      priceChangeH24: -92.5,
      fetchedAt: "2026-08-12T10:00:00.000Z",
    }
    resolveConversationCa.mockImplementation(() => {
      order.push("resolve")
      return {
        subject: `robinhood:${RH_CA}`,
        chainHint: "robinhood",
        tokenHint: RH_CA,
      }
    })
    fetchConversationLiveTape.mockImplementation(async () => {
      order.push("fetch")
      return liveTape
    })
    const runner = vi.fn(async () => {
      order.push("runner")
      return { text: "FDV $12k, liquidity thin, down hard on 24h.", cursorChatId: "chat-1" }
    })
    const client = {
      triggerTyping: vi.fn(async () => undefined),
      sendReply: vi.fn(async () => undefined),
      addReaction: vi.fn(async () => undefined),
    }
    const store = createDiscordStore(discordLayout(join(home, ".trenchcoat")))

    const result = await handleConversationTurn({
      repoRoot: home,
      token: "test-token",
      guildId: "1000000000000000001",
      channelId: CHANNEL_ID,
      messageId: "1000000000000000003",
      userId: "1000000000000000004",
      content: `thoughts on robinhood:${RH_CA}?`,
      client: client as never,
      store,
      runner,
    })

    expect(result).toBe("replied")
    expect(order).toEqual(["resolve", "fetch", "runner"])
    expect(fetchConversationLiveTape).toHaveBeenCalledTimes(1)
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({
      liveTape: expect.objectContaining({ status: "ok", tokenAddress: RH_CA }),
    }))
    expect(client.sendReply).toHaveBeenCalled()
  })

  it("passes undefined liveTape when no CA", async () => {
    resolveConversationCa.mockReturnValue(undefined)
    const runner = vi.fn(async () => ({
      text: "Nothing specific on the board.",
      cursorChatId: "chat-2",
    }))
    const client = {
      triggerTyping: vi.fn(async () => undefined),
      sendReply: vi.fn(async () => undefined),
      addReaction: vi.fn(async () => undefined),
    }
    const store = createDiscordStore(discordLayout(join(home, ".trenchcoat")))

    const result = await handleConversationTurn({
      repoRoot: home,
      token: "test-token",
      guildId: "1000000000000000001",
      channelId: CHANNEL_ID,
      messageId: "1000000000000000005",
      userId: "1000000000000000004",
      content: "how is the board looking?",
      client: client as never,
      store,
      runner,
    })

    expect(result).toBe("replied")
    expect(fetchConversationLiveTape).not.toHaveBeenCalled()
    expect(runner).toHaveBeenCalledTimes(1)
    const call = runner.mock.calls.at(0)?.at(0) as Record<string, unknown> | undefined
    expect(call).toMatchObject({
      channelId: "1000000000000000002",
      memberText: "how is the board looking?",
      authorUserId: "1000000000000000004",
    })
    expect(call).not.toHaveProperty("liveTape")
  })
})
