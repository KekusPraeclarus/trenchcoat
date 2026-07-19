import { describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discordLayout } from "../../src/discord/paths.js"
import { acceptDiscordRequest } from "../../src/discord/pump.js"
import { deliverResearchReply } from "../../src/discord/delivery.js"
import { createDiscordStore, emptyRequestsFile } from "../../src/discord/store.js"
import type { DiscordRequestRecord } from "../../src/discord/schemas.js"
import type { DiscordRestClient } from "../../src/discord/bot-client.js"

vi.mock("../../src/lib/config.js", () => ({
  loadConfig: () => ({
    chat: {
      discord: {
        enabled: true,
        per_user_daily_cap: 20,
        server_daily_cap: 100,
        max_active_per_user: 5,
        model: "composer-2.5-fast",
        watch_days: 30,
        max_watched_tokens: 500,
        max_subscribers_per_token: 100,
      },
    },
  }),
}))

describe("discord intake/delivery race", () => {
  it("does not lose an accepted request while completing another", async () => {
    const home = mkdtempSync(join(tmpdir(), "tc-discord-race-"))
    const prevHome = process.env["HOME"]
    process.env["HOME"] = home
    try {
      const layout = discordLayout(join(home, ".trenchcoat"))
      const store = createDiscordStore(layout)
      const nowIso = "2026-07-19T15:00:00.000Z"
      const running: DiscordRequestRecord = {
        requestId: "1000000000000000003",
        guildId: "1000000000000000001",
        channelId: "1000000000000000002",
        messageId: "1000000000000000003",
        userId: "1000000000000000004",
        subject: "solana:So11111111111111111111111111111111111111112",
        chain: "solana",
        tokenAddress: "So11111111111111111111111111111111111111112",
        status: "running",
        createdAt: nowIso,
        updatedAt: nowIso,
        quotaDay: "2026-07-19",
        deliveredPartKeys: [],
      }
      const file = emptyRequestsFile(nowIso)
      file.requests.push(running)
      file.dailyServer = 1
      file.dailyByUser = { [running.userId]: 1 }
      await store.saveRequests(file)

      let releaseSend!: () => void
      const sendGate = new Promise<void>((resolve) => {
        releaseSend = resolve
      })
      let sendStarted!: () => void
      const sendStartedGate = new Promise<void>((resolve) => {
        sendStarted = resolve
      })

      const client: DiscordRestClient = {
        sendReply: async () => {
          sendStarted()
          await sendGate
          return { messageId: "reply-1" }
        },
        sendChannelMessage: async () => ({ messageId: "chan-1" }),
        addReaction: async () => undefined,
      }

      const delivery = deliverResearchReply({
        client,
        store,
        request: running,
        text: "Research complete.",
      })

      await sendStartedGate

      const accepted = acceptDiscordRequest({
        guildId: running.guildId,
        channelId: running.channelId,
        messageId: "1000000000000000005",
        userId: "1000000000000000006",
        subject: "solana:TokenB1111111111111111111111111111111111111",
        chainHint: "solana",
        tokenHint: "TokenB1111111111111111111111111111111111111",
      })

      // Accept may wait on delivery's store lock after send finishes
      await Promise.resolve()
      releaseSend()
      const [delivered, acceptResult] = await Promise.all([delivery, accepted])

      expect(delivered).toEqual({ ok: true })
      expect("accepted" in acceptResult && acceptResult.accepted).toBe(true)

      const final = store.loadRequests()
      expect(final.requests).toHaveLength(2)
      const completed = final.requests.find((r) => r.requestId === running.requestId)
      const queued = final.requests.find((r) => r.requestId === "1000000000000000005")
      expect(completed?.status).toBe("completed")
      expect(queued?.status).toBe("queued")
    } finally {
      if (prevHome === undefined) delete process.env["HOME"]
      else process.env["HOME"] = prevHome
      rmSync(home, { recursive: true, force: true })
    }
  })
})
