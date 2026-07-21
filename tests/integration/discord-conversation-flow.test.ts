import { describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discordLayout } from "../../src/discord/paths.js"
import { createDiscordStore } from "../../src/discord/store.js"
import {
  appendQueuedDiscordRequest,
} from "../../src/discord/pump.js"
import {
  conversationRequestId,
  pruneOldConversations,
  reclaimStaleConversationClaims,
  SYNTHESIS_LEASE_MS,
} from "../../src/discord/conversation.js"
import { emptyRequestsFile, emptyConversationsFile } from "../../src/discord/store.js"
import { pruneOldRequests, rolloverQuotaDay } from "../../src/discord/store.js"

vi.mock("../../src/lib/config.js", () => ({
  loadConfig: () => ({
    chat: {
      discord: {
        enabled: true,
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

describe("discord conversation flow integration", () => {
  it("enqueues conversation-origin requests and conversation record atomically", async () => {
    const home = mkdtempSync(join(tmpdir(), "tc-conv-flow-"))
    const prevHome = process.env["HOME"]
    process.env["HOME"] = home
    try {
      const layout = discordLayout(join(home, ".trenchcoat"))
      const store = createDiscordStore(layout)
      const nowIso = "2026-07-21T12:00:00.000Z"
      let requests = rolloverQuotaDay(pruneOldRequests(emptyRequestsFile(nowIso), nowIso), nowIso)
      const messageId = "1000000000000000003"
      const ids = [0, 1].map((i) => conversationRequestId(messageId, i))
      for (const [i, requestId] of ids.entries()) {
        const appended = appendQueuedDiscordRequest(requests, {
          requestId,
          guildId: "1000000000000000001",
          channelId: "1000000000000000002",
          messageId,
          userId: "1000000000000000004",
          subject: i === 0 ? "$KARMA on robinhood" : "$WALLET on robinhood",
          chainHint: "robinhood",
          origin: "conversation",
          nowIso,
        })
        requests = appended.file
      }
      await store.saveRequests(requests)
      let conversations = emptyConversationsFile()
      conversations = {
        ...conversations,
        conversations: [{
          conversationId: messageId,
          guildId: "1000000000000000001",
          channelId: "1000000000000000002",
          userId: "1000000000000000004",
          question: "which looks better $KARMA or $WALLET",
          cursorChatId: "chat-1",
          requestIds: ids,
          status: "awaiting-research",
          createdAt: nowIso,
          updatedAt: nowIso,
        }],
      }
      await store.saveConversations(conversations)

      const loadedReq = store.loadRequests()
      expect(loadedReq.requests).toHaveLength(2)
      expect(loadedReq.requests.every((r) => r.origin === "conversation")).toBe(true)
      expect(store.loadConversations().conversations[0]!.requestIds).toEqual(ids)
    } finally {
      if (prevHome === undefined) delete process.env["HOME"]
      else process.env["HOME"] = prevHome
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe("discord conversation crash resume", () => {
  it("reclaims synthesizing past lease", () => {
    const nowIso = "2026-07-21T12:00:00.000Z"
    const staleAt = new Date(Date.parse(nowIso) - SYNTHESIS_LEASE_MS - 1_000).toISOString()
    const file = {
      schema: 1 as const,
      conversations: [{
        conversationId: "1000000000000000003",
        guildId: "1000000000000000001",
        channelId: "1000000000000000002",
        userId: "1000000000000000004",
        question: "q",
        cursorChatId: "c",
        requestIds: ["conv-1000000000000000003-0"],
        status: "synthesizing" as const,
        createdAt: staleAt,
        updatedAt: staleAt,
        claimedAt: staleAt,
      }],
    }
    const next = reclaimStaleConversationClaims(file, nowIso)
    expect(next.conversations[0]!.status).toBe("awaiting-research")
    expect(next.conversations[0]!.claimedAt).toBeUndefined()
  })

  it("prunes old conversations", () => {
    const nowIso = "2026-07-21T12:00:00.000Z"
    const old = "2026-01-01T00:00:00.000Z"
    const file = {
      schema: 1 as const,
      conversations: [{
        conversationId: "1000000000000000003",
        guildId: "1000000000000000001",
        channelId: "1000000000000000002",
        userId: "1000000000000000004",
        question: "q",
        cursorChatId: "c",
        requestIds: ["conv-1000000000000000003-0"],
        status: "answered" as const,
        createdAt: old,
        updatedAt: old,
      }],
    }
    expect(pruneOldConversations(file, nowIso).conversations).toHaveLength(0)
  })
})
