import { describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discordLayout } from "../../src/discord/paths.js"
import { createDiscordStore, emptyWatchlistFile } from "../../src/discord/store.js"
import { runWatchExpirySweep } from "../../src/discord/watch-expiry.js"
import { applyWatchExpiryReply } from "../../src/discord/watchlist.js"
import type { DiscordRestClient } from "../../src/discord/bot-client.js"
import type { DiscordWatchlistFile } from "../../src/discord/schemas.js"

vi.mock("../../src/lib/config.js", () => ({
  loadConfig: () => ({
    chat: {
      discord: {
        enabled: true,
        watch_days: 30,
        watch_expiry_reply_window_days: 7,
        max_watched_tokens: 500,
        max_subscribers_per_token: 100,
      },
    },
  }),
}))

describe("discord watch renewal integration", () => {
  it("sweeps notice once then renews on yes reply", async () => {
    const home = mkdtempSync(join(tmpdir(), "tc-watch-exp-"))
    const prevHome = process.env["HOME"]
    process.env["HOME"] = home
    try {
      const layout = discordLayout(join(home, ".trenchcoat"))
      const store = createDiscordStore(layout)
      const nowIso = "2026-07-21T12:00:00.000Z"
      const file: DiscordWatchlistFile = {
        ...emptyWatchlistFile(),
        tokens: [
          {
            chain: "solana",
            tokenAddress: "CREDBH1234567890123456789012345678901234",
            symbolDisplay: "CRED",
            subscriptions: [
              {
                guildId: "1000000000000000001",
                userId: "1000000000000000004",
                channelId: "1000000000000000002",
                messageId: "1000000000000000003",
                startedAt: "2026-06-01T12:00:00.000Z",
                renewedAt: "2026-06-01T12:00:00.000Z",
                expiresAt: "2026-07-20T12:00:00.000Z",
              },
            ],
          },
        ],
      }
      await store.saveWatchlist(file)

      const messages: string[] = []
      const client: DiscordRestClient = {
        sendReply: async () => ({ messageId: "1" }),
        sendChannelMessage: async ({ content }) => {
          messages.push(content)
          return { messageId: "2000000000000000099" }
        },
        addReaction: async () => undefined,
      }

      const first = await runWatchExpirySweep({ token: "t", client, store, nowIso })
      const second = await runWatchExpirySweep({ token: "t", client, store, nowIso })
      expect(first).toBe(1)
      expect(second).toBe(0)
      expect(messages).toHaveLength(1)
      expect(messages[0]).toContain("CRED")

      const noticed = store.loadWatchlist()
      expect(noticed.tokens[0]!.subscriptions[0]!.expiryNoticeMessageId).toBe(
        "2000000000000000099",
      )

      const renewed = applyWatchExpiryReply({
        file: noticed,
        noticeMessageId: "2000000000000000099",
        userId: "1000000000000000004",
        decision: "yes",
        nowIso,
      })
      expect(renewed.ok).toBe(true)
      if (!renewed.ok) return
      await store.saveWatchlist(renewed.file)
      const loaded = store.loadWatchlist()
      expect(Date.parse(loaded.tokens[0]!.subscriptions[0]!.expiresAt)).toBeGreaterThan(
        Date.parse(nowIso),
      )
      expect(loaded.tokens[0]!.subscriptions[0]!.expiryNoticeMessageId).toBeUndefined()
    } finally {
      if (prevHome === undefined) delete process.env["HOME"]
      else process.env["HOME"] = prevHome
      rmSync(home, { recursive: true, force: true })
    }
  })
})
