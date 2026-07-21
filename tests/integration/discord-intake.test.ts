import { describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discordLayout } from "../../src/discord/paths.js"
import { acceptDiscordRequest } from "../../src/discord/pump.js"
import { createDiscordStore } from "../../src/discord/store.js"

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
      },
    },
  }),
}))

describe("discord intake integration", () => {
  it("accepts a recognized request and dedupes by message id", async () => {
    const home = mkdtempSync(join(tmpdir(), "tc-discord-int-"))
    const prevHome = process.env["HOME"]
    process.env["HOME"] = home
    try {
      const layout = discordLayout(join(home, ".trenchcoat"))
      const store = createDiscordStore(layout)
      const args = {
        guildId: "1000000000000000001",
        channelId: "1000000000000000002",
        messageId: "1000000000000000003",
        userId: "1000000000000000004",
        subject: "solana:So11111111111111111111111111111111111111112",
        chainHint: "solana",
        tokenHint: "So11111111111111111111111111111111111111112",
      }
      const first = await acceptDiscordRequest(args)
      expect("accepted" in first && first.accepted).toBe(true)
      const second = await acceptDiscordRequest(args)
      expect("duplicate" in second).toBe(true)
      const file = store.loadRequests()
      expect(file.requests).toHaveLength(1)
    } finally {
      if (prevHome === undefined) delete process.env["HOME"]
      else process.env["HOME"] = prevHome
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("queues many concurrent requests with no per-user depth cap", async () => {
    const home = mkdtempSync(join(tmpdir(), "tc-discord-queue-"))
    const prevHome = process.env["HOME"]
    process.env["HOME"] = home
    try {
      const layout = discordLayout(join(home, ".trenchcoat"))
      const store = createDiscordStore(layout)
      const base = {
        guildId: "1000000000000000001",
        channelId: "1000000000000000002",
        userId: "1000000000000000004",
        chainHint: "solana",
      }
      const results = []
      for (let i = 0; i < 21; i += 1) {
        const messageId = String(1_000_000_000_000_000_003n + BigInt(i))
        const token = `Token${String(i).padStart(2, "0")}111111111111111111111111111111111111`
        results.push(await acceptDiscordRequest({
          ...base,
          messageId,
          subject: `solana:${token}`,
          tokenHint: token,
        }))
      }
      expect(results.every((r) => "accepted" in r && r.accepted)).toBe(true)
      const file = store.loadRequests()
      expect(file.requests).toHaveLength(21)
      expect(file.requests.every((r) => r.status === "queued")).toBe(true)
      expect(file.requests.map((r) => r.createdAt).every((a, i, arr) => (
        i === 0 || arr[i - 1]! <= a
      ))).toBe(true)
    } finally {
      if (prevHome === undefined) delete process.env["HOME"]
      else process.env["HOME"] = prevHome
      rmSync(home, { recursive: true, force: true })
    }
  })
})
