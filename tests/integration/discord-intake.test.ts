import { describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discordLayout } from "../../src/discord/paths.js"
import { acceptDiscordRequest } from "../../src/discord/pump.js"
import { createDiscordStore } from "../../src/discord/store.js"
import { DISCORD_ERRORS } from "../../src/discord/quota.js"

vi.mock("../../src/lib/config.js", () => ({
  loadConfig: () => ({
    chat: {
      discord: {
        enabled: true,
        per_user_daily_cap: 5,
        server_daily_cap: 20,
        max_active_per_user: 2,
        model: "composer-2.5-fast",
        watch_days: 30,
        max_watched_tokens: 500,
        max_subscribers_per_token: 100,
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
      expect(file.dailyServer).toBe(1)
    } finally {
      if (prevHome === undefined) delete process.env["HOME"]
      else process.env["HOME"] = prevHome
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("queues a second concurrent request instead of failing", async () => {
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
        subject: "solana:So11111111111111111111111111111111111111112",
        chainHint: "solana",
        tokenHint: "So11111111111111111111111111111111111111112",
      }
      const first = await acceptDiscordRequest({ ...base, messageId: "1000000000000000003" })
      expect("accepted" in first && first.accepted).toBe(true)
      const second = await acceptDiscordRequest({
        ...base,
        messageId: "1000000000000000005",
        subject: "solana:TokenB1111111111111111111111111111111111111",
        tokenHint: "TokenB1111111111111111111111111111111111111",
      })
      expect("accepted" in second && second.accepted).toBe(true)
      const third = await acceptDiscordRequest({
        ...base,
        messageId: "1000000000000000006",
        subject: "solana:TokenC1111111111111111111111111111111111111",
        tokenHint: "TokenC1111111111111111111111111111111111111",
      })
      expect(third).toEqual({
        accepted: false,
        terminal: DISCORD_ERRORS.ACTIVE,
      })
      const file = store.loadRequests()
      expect(file.requests.map((r) => r.status)).toEqual(["queued", "queued"])
      expect(file.dailyServer).toBe(2)
    } finally {
      if (prevHome === undefined) delete process.env["HOME"]
      else process.env["HOME"] = prevHome
      rmSync(home, { recursive: true, force: true })
    }
  })
})
