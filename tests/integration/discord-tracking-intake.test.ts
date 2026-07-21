import { describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discordLayout } from "../../src/discord/paths.js"
import { createDiscordStore } from "../../src/discord/store.js"
import { handleTrackingMessage } from "../../src/discord/tracking-intent.js"
import { DISCORD_TRACKING_ACK_EMOJI } from "../../src/discord/tracking-intent.js"
import type { DiscordRestClient } from "../../src/discord/bot-client.js"

vi.mock("../../src/lib/config.js", () => ({
  loadConfig: () => ({
    chat: {
      discord: {
        enabled: true,
        model: "composer-2.5-fast",
        watch_days: 30,
        watch_expiry_reply_window_days: 7,
        max_watched_tokens: 500,
        max_subscribers_per_token: 100,
        conversation: {
          enabled: false,
          model: "composer-2.5",
          classifier_model: "composer-2.5-fast",
          idle_timeout_minutes: 30,
          context_messages: 10,
          channel_ids: [],
          max_research_per_turn: 5,
        },
        tracking: {
          enabled: true,
          intent_model: "composer-2.5",
          match_model: "composer-2.5",
          max_active_per_user: 10,
          ttl_days: 30,
          expiry_bundle_hours: 48,
          pending_capacity_ttl_hours: 48,
          tentative_confirm_window_hours: 24,
          expiry_reply_window_days: 7,
          match_max_attempts: 5,
          match_stale_running_ms: 900_000,
          retention_days: 35,
        },
      },
    },
  }),
}))

describe("discord tracking intake integration", () => {
  it("tracks via injected session and reacts with salute after commit", async () => {
    const home = mkdtempSync(join(tmpdir(), "tc-trk-int-"))
    const prevHome = process.env["HOME"]
    process.env["HOME"] = home
    try {
      const layout = discordLayout(join(home, ".trenchcoat"))
      const store = createDiscordStore(layout)
      const reactions: string[] = []
      const replies: string[] = []
      const client: DiscordRestClient = {
        sendReply: async ({ content }) => {
          replies.push(content)
          return { messageId: "2000000000000000001" }
        },
        sendChannelMessage: async ({ content }) => {
          replies.push(content)
          return { messageId: "2000000000000000002" }
        },
        addReaction: async ({ emoji }) => {
          reactions.push(emoji)
        },
      }

      const status = await handleTrackingMessage({
        repoRoot: process.cwd(),
        token: "test",
        guildId: "1000000000000000001",
        channelId: "1000000000000000002",
        messageId: "1000000000000000003",
        userId: "1000000000000000004",
        content: "@bot lmk when privacy mixer launches on RH",
        mentionsBot: true,
        replyToBot: false,
        client,
        store,
        nowIso: "2026-07-21T12:00:00.000Z",
        runSession: async (args) => {
          expect(args.model).toBe("composer-2.5")
          expect(args.mode).toBe("ask")
          expect(args.sandbox).toBe(true)
          expect(args.prompt).not.toContain("privacy mixer")
          expect(args.prompt).toMatch(/inbox\/tracking-intent-/u)
          return {
            status: "finished",
            text: JSON.stringify({
              action: "track",
              description: "privacy mixer on RH with decent backing",
              shortLabel: "Privacy on RH",
              confidence: "high",
            }),
          }
        },
      })

      expect(status).toBe("processed")
      expect(reactions).toEqual([DISCORD_TRACKING_ACK_EMOJI])
      expect(store.loadTracking().requests).toHaveLength(1)
      expect(store.loadTracking().requests[0]!.status).toBe("active")
      expect(replies).toHaveLength(0)
    } finally {
      if (prevHome === undefined) delete process.env["HOME"]
      else process.env["HOME"] = prevHome
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("ignores non-mention messages", async () => {
    const status = await handleTrackingMessage({
      repoRoot: process.cwd(),
      token: "test",
      guildId: "1000000000000000001",
      channelId: "1000000000000000002",
      messageId: "1000000000000000003",
      userId: "1000000000000000004",
      content: "lmk when privacy launches",
      mentionsBot: false,
      replyToBot: false,
      runSession: async () => {
        throw new Error("should not run")
      },
    })
    expect(status).toBe("ignored")
  })

  it("fail-closes on malformed session output without mutation", async () => {
    const home = mkdtempSync(join(tmpdir(), "tc-trk-fail-"))
    const prevHome = process.env["HOME"]
    process.env["HOME"] = home
    try {
      const layout = discordLayout(join(home, ".trenchcoat"))
      const store = createDiscordStore(layout)
      const reactions: string[] = []
      const client: DiscordRestClient = {
        sendReply: async () => ({ messageId: "1" }),
        sendChannelMessage: async () => ({ messageId: "2" }),
        addReaction: async ({ emoji }) => { reactions.push(emoji) },
      }
      const status = await handleTrackingMessage({
        repoRoot: process.cwd(),
        token: "test",
        guildId: "1000000000000000001",
        channelId: "1000000000000000002",
        messageId: "1000000000000000003",
        userId: "1000000000000000004",
        content: "@bot track stuff",
        mentionsBot: true,
        replyToBot: false,
        client,
        store,
        nowIso: "2026-07-21T12:00:00.000Z",
        runSession: async () => ({ status: "finished", text: "not-json" }),
      })
      expect(status).toBe("failed")
      expect(store.loadTracking().requests).toHaveLength(0)
      expect(reactions).toHaveLength(0)
    } finally {
      if (prevHome === undefined) delete process.env["HOME"]
      else process.env["HOME"] = prevHome
      rmSync(home, { recursive: true, force: true })
    }
  })
})
